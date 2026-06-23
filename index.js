const { Schema, h } = require('koishi')
const fs = require('fs')
const path = require('path')

const DOUYIN_API = 'https://live.douyin.com/webcast/room/web/enter/'
const STATE_FILE = path.join(__dirname, 'live_state.json')

const StreamerConfig = Schema.object({
  name: Schema.string().required().description('主播名称（通知时显示）'),
  account: Schema.string().required().description('抖音账号（网页版 URL 最后一段，如 https://live.douyin.com/xxxxx）'),
  groups: Schema.array(Schema.string()).default([]).description('通知群号（留空=所有群）'),
  enabled: Schema.boolean().default(true).description('是否启用'),
})

const Config = Schema.object({
  interval: Schema.number().default(60).min(30).max(600).description('轮询间隔（秒，建议 60-120）'),
  streamers: Schema.array(StreamerConfig).default([]).description('监控主播列表'),
})

function apply(ctx, config) {
  // 状态记录：account → room_status
  const statusMap = {}

  // 加载上次持久化状态（防重启重复推送）
  function loadState() {
    try { if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) } catch {}
    return {}
  }
  function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(statusMap, null, 2), 'utf-8')
  }
  Object.assign(statusMap, loadState())

  let ttwid = ''
  let timer = null

  // ===== 生成 ttwid =====
  function genTtwid() {
    // ttwid 本质是浏览器指纹 UUID，本地生成即可
    const hex = () => Math.random().toString(16).substring(2, 10)
    return `${hex()}${hex()}${hex()}${hex()}`
  }
  ttwid = genTtwid()
  ctx.logger.info(`[douyin] ttwid 已生成: ${ttwid.substring(0, 16)}...`)

  // ===== 查询单个主播状态 =====
  async function checkStreamer(s) {
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': `https://live.douyin.com/${s.account}`,
        'Cookie': `ttwid=${ttwid}`,
      }

      const res = await ctx.http.get(DOUYIN_API, {
        params: {
          aid: '6383',
          device_platform: 'web',
          enter_from: 'web_live',
          cookie_enabled: 'true',
          browser_language: 'zh-CN',
          browser_platform: 'Win32',
          browser_name: 'Chrome',
          browser_version: '120.0.0.0',
          web_rid: s.account,
        },
        headers,
        responseType: 'json',
        timeout: 10000,
      })

      // res 就是解析后的 JSON
      const json = res
      if (!json || typeof json !== 'object') return

      // Douyin 响应结构: { data: { status_code: 0, data: [...], room_status: 2, user: {...} } }
      const inner = json.data || json
      const statusCode = inner.status_code

      if (statusCode !== 0) {
        ctx.logger.warn(`[douyin] "${s.name}" status_code=${statusCode}`)
        if (statusCode === 1500) ttwid = genTtwid()
        return
      }

      const roomList = inner.data
      if (!roomList || (Array.isArray(roomList) && roomList.length === 0)) {
        // 没开播
        ctx.logger.info(`[douyin] "${s.name}" 未开播`)
        updateStatus(s, 1, {})
        return
      }

      const room = Array.isArray(roomList) ? roomList[0] : roomList
      // room_status 位置：inner.room_status 或 room.status
      const roomStatus = inner.room_status ?? room.status ?? room.room_status
      const roomTitle = room.title || ''
      const coverUrl = (room.cover && room.cover.url_list && room.cover.url_list[0]) || ''
      const nickname = (inner.user && inner.user.nickname) || s.name
      const avatarUrl = (inner.user && inner.user.avatar_thumb && inner.user.avatar_thumb.url_list && inner.user.avatar_thumb.url_list[0]) || ''

      if (roomStatus === undefined || roomStatus === null) {
        ctx.logger.warn(`[douyin] "${s.name}" 无法获取 room_status, 响应: ${JSON.stringify(inner).substring(0, 200)}`)
        return
      }

      ctx.logger.info(`[douyin] "${s.name}" 状态=${roomStatus} 标题="${roomTitle}"`)

      updateStatus(s, roomStatus, {
        title: roomTitle,
        cover: coverUrl,
        nickname,
        avatar: avatarUrl,
      })
    } catch (e) {
      ctx.logger.warn(`[douyin] "${s.name}" 查询异常: ${e.message}`)
    }
  }

  function updateStatus(streamer, newStatus, info) {
    const oldStatus = statusMap[streamer.account]

    if (oldStatus === undefined) {
      // 首次检测
      statusMap[streamer.account] = newStatus
      saveState()
      const isLive = (newStatus === 0 || newStatus === 2)
      ctx.logger.info(`[douyin] "${streamer.name}" 初始: ${statusLabel(newStatus)}${isLive ? ' → 推送' : ''}`)
      if (isLive) {
        pushLiveStart(streamer, info)
      }
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
    const map = { 0: '直播中(0)', 1: '未开播(1)', 2: '直播中(2)', 3: '回放(3)', 4: '下播(4)' }
    return map[s] || `未知(${s})`
  }

  // ===== 推送通知 =====
  async function pushLiveStart(s, info) {
    const msg = [
      `🔴 ${info.nickname || s.name} 开播了！\n标题：${info.title || '无'}\n`,
    ]
    // 封面图
    if (info.cover) {
      msg.push(h.image(info.cover))
      msg.push('\n')
    }
    msg.push(`直播间：https://live.douyin.com/${s.account}`)

    await sendToGroups(s, msg)
    ctx.logger.info(`[douyin] 🔴 "${s.name}" 开播 → 推送到 ${s.groups?.length || '所有'} 群`)
  }

  async function pushLiveEnd(s, info) {
    const msg = [
      `⚫ ${info.nickname || s.name} 下播了\n直播间：https://live.douyin.com/${s.account}`,
    ]
    await sendToGroups(s, msg)
    ctx.logger.info(`[douyin] ⚫ "${s.name}" 下播 → 推送到 ${s.groups?.length || '所有'} 群`)
  }

  async function sendToGroups(streamer, msg) {
    const bots = ctx.bots || []
    if (bots.length === 0) return

    const targetGroups = streamer.groups && streamer.groups.length > 0
      ? streamer.groups
      : null

    for (const bot of bots) {
      if (targetGroups) {
        for (const gid of targetGroups) {
          try { await bot.sendMessage(gid, msg) } catch {}
        }
      }
    }
  }

  // ===== 轮询循环 =====
  async function pollAll() {
    const enabled = (config.streamers || []).filter(s => s.enabled !== false)
    if (enabled.length === 0) return

    for (const s of enabled) {
      if (!s.account) continue
      await checkStreamer(s)
    }
  }

  // ===== 启动 =====
  async function start() {
    // 先跑一轮检测
    await pollAll()
    // 开始定时
    timer = setInterval(pollAll, (config.interval || 60) * 1000)
    ctx.logger.info(`[douyin] 开始监控 ${(config.streamers || []).filter(s => s.enabled !== false).length} 个主播，间隔 ${config.interval || 60}s`)
  }

  // ===== 命令 =====
  ctx.command('douyin', '抖音直播监控')
    .action(() =>
      '抖音直播开播/下播提醒\n' +
      '配置方法：插件设置页 → 添加主播\n' +
      'douyin.list — 查看当前监控状态\n' +
      'douyin.check — 手动查询一次'
    )

  ctx.command('douyin.list', '查看监控状态')
    .action(() => {
      const streamers = config.streamers || []
      if (!streamers.length) return '未配置任何主播'
      return streamers.map(s => {
        const st = statusMap[s.account]
        const label = st !== undefined ? statusLabel(st) : '未知'
        return `  ${s.enabled ? '✅' : '⛔'} ${s.name} (${s.account}) → ${label}`
      }).join('\n')
    })

  ctx.command('douyin.check', '手动查询一次')
    .action(async () => {
      await pollAll()
      return '已查询，用 douyin.list 查看状态'
    })

  // 启动监控
  start()

  // 清理
  ctx.on('dispose', () => {
    if (timer) clearInterval(timer)
  })
}

module.exports = { Config, apply }
