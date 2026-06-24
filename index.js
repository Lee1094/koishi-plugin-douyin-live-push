const { Schema, h } = require('koishi')
const fs = require('fs')
const path = require('path')

const STATE_FILE = path.join(__dirname, 'live_state.json')

const StreamerConfig = Schema.object({
  name: Schema.string().required().description('主播名称'),
  account: Schema.string().required().description('抖音账号（live.douyin.com/ 后面的部分）'),
  groups: Schema.array(Schema.string()).default([]).description('通知群号'),
  enabled: Schema.boolean().default(true).description('启用'),
})

const Config = Schema.object({
  interval: Schema.number().default(60).min(30).max(600).description('轮询间隔（秒）'),
  streamers: Schema.array(StreamerConfig).default([]).description('主播列表'),
})

function apply(ctx, config) {
  const statusMap = {}

  function loadState() {
    try { if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) } catch {}
    return {}
  }
  function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(statusMap, null, 2), 'utf-8')
  }
  Object.assign(statusMap, loadState())

  let timer = null, ttwid = ''

  // ===== 获取 ttwid（和 aio-dynamic-push 同样的方式）=====
  async function getTtwid() {
    try {
      const res = await ctx.http.post('https://ttwid.bytedance.com/ttwid/union/register/', {
        region: 'cn', aid: 6383, needFid: false,
        service: 'www.ixigua.com',
        migrate_info: { ticket: '', source: 'node' },
        cbUrlProtocol: 'https', union: true,
      }, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Content-Type': 'application/json' },
        responseType: 'text',
      })
      // 响应可能是 { headers: {...} } 或纯文本
      const headers = res?.headers || {}
      const setCookie = headers['set-cookie'] || headers['Set-Cookie'] || ''
      if (typeof setCookie === 'string') {
        const m = setCookie.match(/ttwid=([^;]+)/)
        if (m) ttwid = m[1]
      }
      if (!ttwid) {
        // 尝试从响应体提取
        try {
          const body = typeof res === 'string' ? JSON.parse(res) : res
          if (body?.ttwid) ttwid = body.ttwid
        } catch {}
      }
    } catch (e) {}
    if (!ttwid) {
      // 本地生成兜底
      const h = () => Math.random().toString(16).substring(2, 10)
      ttwid = `1|${h()}${h()}${h()}${h()}|${Math.floor(Date.now()/1000)}|${h()}${h()}${h()}${h()}`
    }
    ctx.logger.info(`[douyin] ttwid=${ttwid.substring(0, 20)}...`)
  }

  // ===== 查询单个主播（API 方式）=====
  async function checkStreamer(s) {
    if (!ttwid) return
    try {
      const raw = await ctx.http.get('https://live.douyin.com/webcast/room/web/enter/', {
        params: { aid: '6383', device_platform: 'web', enter_from: 'web_live', cookie_enabled: 'true', browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Chrome', browser_version: '120.0.0.0', web_rid: s.account },
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Cookie': `ttwid=${ttwid}`, 'Referer': `https://live.douyin.com/${s.account}` },
        responseType: 'text', timeout: 10000,
      })
      if (!raw || raw.length < 10) return
      const json = JSON.parse(raw)
      const inner = (json && json.data) || json
      if (inner.status_code !== 0) { ctx.logger.warn(`[douyin] "${s.name}" code=${inner.status_code}`); return }
      const list = inner.data
      if (!list || !Array.isArray(list) || !list.length) { updateStatus(s, 1, {}); return }
      const room = list[0]
      const st = inner.room_status ?? room.status
      ctx.logger.info(`[douyin] "${s.name}" 状态=${st} 标题="${room.title||''}"`)
      updateStatus(s, st, { title: room.title||'', cover: room.cover?.url_list?.[0]||'', nickname: inner.user?.nickname||s.name, avatar: '' })
    } catch (e) { ctx.logger.debug(`[douyin] "${s.name}" err: ${e.message}`) }
  }

  function updateStatus(streamer, newStatus, info) {
    const oldStatus = statusMap[streamer.account]

    if (oldStatus === undefined) {
      statusMap[streamer.account] = newStatus
      saveState()
      const isLive = (newStatus === 0 || newStatus === 2)
      ctx.logger.info(`[douyin] "${streamer.name}" 初始: ${statusLabel(newStatus)}${isLive ? ' → 推送' : ''}`)
      if (isLive) pushLiveStart(streamer, info)
      return
    }

    if (oldStatus === newStatus) return

    statusMap[streamer.account] = newStatus
    saveState()

    if (newStatus === 0 || newStatus === 2) {
      pushLiveStart(streamer, info)
    } else if (newStatus === 1 || newStatus === 3 || newStatus === 4) {
      pushLiveEnd(streamer, info)
    }
  }

  function statusLabel(s) {
    const map = { 0: '直播(0)', 1: '未开播', 2: '直播(2)', 3: '回放', 4: '下播' }
    return map[s] || `未知(${s})`
  }

  // ===== 推送 =====
  async function pushLiveStart(s, info) {
    const msg = [`🔴 ${info.nickname || s.name} 开播了！\n标题：${info.title || '无'}\n`]
    if (info.cover) { msg.push(h.image(info.cover)); msg.push('\n') }
    msg.push(`直播间：https://live.douyin.com/${s.account}`)
    await sendToGroups(s, msg)
    ctx.logger.info(`[douyin] 🔴 "${s.name}" 开播 → ${s.groups?.length || 0}群`)
  }

  async function pushLiveEnd(s, info) {
    const msg = [`⚫ ${info.nickname || s.name} 下播了\n直播间：https://live.douyin.com/${s.account}`]
    await sendToGroups(s, msg)
    ctx.logger.info(`[douyin] ⚫ "${s.name}" 下播`)
  }

  async function sendToGroups(streamer, msg) {
    const bots = ctx.bots || []
    if (!bots.length) return
    for (const bot of bots) {
      const groups = streamer.groups && streamer.groups.length > 0 ? streamer.groups : null
      if (groups) {
        for (const gid of groups) { try { await bot.sendMessage(gid, msg) } catch {} }
      }
    }
  }

  // ===== 轮询 =====
  async function pollAll() {
    const enabled = (config.streamers || []).filter(s => s.enabled !== false)
    for (const s of enabled) {
      if (!s.account) continue
      await checkStreamer(s)
    }
  }

  // ===== 启动 =====
  async function start() {
    await getTtwid()
    await pollAll()
    timer = setInterval(pollAll, (config.interval || 60) * 1000)
    ctx.logger.info(`[douyin] 监控 ${(config.streamers || []).filter(s => s.enabled !== false).length} 个主播，间隔 ${config.interval || 60}s`)
  }

  // ===== 命令 =====
  ctx.command('douyin', '抖音直播监控')
    .action(() => 'douyin.list — 状态 | douyin.check — 手动查 | 配置: 插件设置页')

  ctx.command('douyin.list', '查看状态')
    .action(() => {
      const ss = config.streamers || []
      if (!ss.length) return '未配置主播'
      return ss.map(s => {
        const st = statusMap[s.account]
        return `  ${s.enabled ? '✅' : '⛔'} ${s.name} → ${st !== undefined ? statusLabel(st) : '未知'}`
      }).join('\n')
    })

  ctx.command('douyin.check', '手动查询')
    .action(async () => { await pollAll(); return '已查，douyin.list 看结果' })

  start()
  ctx.on('dispose', () => { if (timer) clearInterval(timer) })
}

module.exports = { Config, apply }
