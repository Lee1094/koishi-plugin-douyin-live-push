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

  let timer = null

  // ===== 查询主播：直接抓页面 HTML 提取数据 =====
  async function checkStreamer(s) {
    try {
      // 完整模拟浏览器
      const html = await ctx.http.get(`https://live.douyin.com/${s.account}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'max-age=0',
          'Sec-Ch-Ua': '"Google Chrome";v="120", "Not?A_Brand";v="8"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Upgrade-Insecure-Requests': '1',
        },
        responseType: 'text',
        timeout: 15000,
      })

      if (!html || html.length < 500) {
        ctx.logger.warn(`[douyin] "${s.name}" 页面过短(${html ? html.length : 0}字节)`)
        return
      }

      // 括号计数提取完整 JSON 块
      const extractJSON = (str, key) => {
        // 先定位 key
        const idx = str.indexOf(`"${key}"`)
        if (idx < 0) return null
        // 从 key 后面找第一个 { 或 [
        let i = idx + key.length + 2 // skip "key"
        while (i < str.length && str[i] !== '{' && str[i] !== '[') i++
        if (i >= str.length) return null
        const open = str[i], close = open === '{' ? '}' : ']'
        let depth = 0, start = i
        while (i < str.length) {
          if (str[i] === '\\') { i += 2; continue }
          if (str[i] === open) depth++
          else if (str[i] === close) { depth--; if (depth === 0) break }
          i++
        }
        if (depth !== 0) return null
        try { return JSON.parse(str.substring(start, i + 1)) } catch { return null }
      }

      // 提取 roomStore
      let roomStore = extractJSON(html, 'roomStore')
      if (!roomStore) {
        // 备选: 从 __INIT_PROPS__ 整块提取
        const ipMatch = html.match(/(?:window|self)\.__INIT_PROPS__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i)
        if (ipMatch) {
          try {
            const initProps = JSON.parse(ipMatch[1])
            roomStore = initProps?.roomStore || initProps?.app?.initialState?.roomStore
          } catch {}
        }
      }

      if (!roomStore) {
        ctx.logger.warn(`[douyin] "${s.name}" 未提取到 roomStore (${html.length}B)`)
        return
      }

      // 提取直播状态
      const roomInfo = roomStore.roomInfo || {}
      const room = roomInfo.room
      const roomStatus = room ? room.status : (roomStore.liveStatus === 'live' ? 2 : 1)
      const roomTitle = room?.title || ''
      const coverUrl = room?.cover?.url_list?.[0] || ''
      const nickname = roomInfo?.anchor?.nickname || s.name

      ctx.logger.info(`[douyin] "${s.name}" 状态=${roomStatus} 标题="${roomTitle}" roomInfo=${!!room}`)

      updateStatus(s, roomStatus, {
        title: roomTitle,
        cover: coverUrl,
        nickname,
        avatar: '',
      })
    } catch (e) {
      ctx.logger.warn(`[douyin] "${s.name}" 异常: ${e.message}`)
    }
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
