const { Schema, h } = require('koishi')
const fs = require('fs')
const path = require('path')

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

  let timer = null

  // ===== 构造 Cookie =====
  function genUUID() {
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
    })
  }
  // ttwid 格式: 1|uuid|timestamp|hash
  const ttwid = `1|${genUUID()}|${Math.floor(Date.now() / 1000)}|${genUUID()}`
  const cookieStr = `ttwid=${ttwid}`
  ctx.logger.info(`[douyin] ttwid=${ttwid.substring(0, 40)}...`)

  // ===== 查询单个主播状态（API 方式 + 真实 Cookie）=====
  async function checkStreamer(s) {
    try {
      const url = `https://live.douyin.com/webcast/room/web/enter/?aid=6383&device_platform=web&enter_from=web_live&cookie_enabled=true&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=120.0.0.0&web_rid=${s.account}`
      const raw = await ctx.http.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': `https://live.douyin.com/${s.account}`,
          'Cookie': cookieStr,
        },
        responseType: 'text',
        timeout: 10000,
      })

      if (!raw || raw.length < 10) {
        // 可能是网络不通，试一下主页看能不能访问
        try {
          const test = await ctx.http.get('https://live.douyin.com/', { responseType: 'text', timeout: 5000 })
          ctx.logger.warn(`[douyin] "${s.name}" API空但主页可达(${typeof test === 'string' ? test.length : '?'}字节)`)
        } catch {
          ctx.logger.error(`[douyin] 网络不通: 无法访问 live.douyin.com`)
        }
        return
      }

      let json
      try { json = JSON.parse(raw) } catch {
        ctx.logger.warn(`[douyin] "${s.name}" 非JSON(${raw.length}B): ${raw.substring(0, 200)}`)
        return
      }

      // 响应结构: { data: { status_code, data: [...], room_status, user: {...} } }
      const inner = json.data || json
      const statusCode = inner.status_code
      if (statusCode !== 0) {
        ctx.logger.warn(`[douyin] "${s.name}" status_code=${statusCode} msg=${inner.status_msg || ''}`)
        return
      }

      const roomList = inner.data
      if (!roomList || !Array.isArray(roomList) || roomList.length === 0) {
        ctx.logger.info(`[douyin] "${s.name}" 未开播`)
        updateStatus(s, 1, {})
        return
      }

      const room = roomList[0]
      const roomStatus = inner.room_status ?? room.status ?? room.room_status
      const roomTitle = room.title || ''
      const coverUrl = (room.cover && room.cover.url_list && room.cover.url_list[0]) || ''
      const nickname = (inner.user && inner.user.nickname) || s.name

      ctx.logger.info(`[douyin] "${s.name}" 状态=${roomStatus} 标题="${roomTitle}"`)

      updateStatus(s, roomStatus, {
        title: roomTitle,
        cover: coverUrl,
        nickname,
        avatar: '',
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
    await pollAll()
    timer = setInterval(pollAll, (config.interval || 60) * 1000)
    ctx.logger.info(`[douyin] 开始监控 ${(config.streamers || []).filter(s => s.enabled !== false).length} 个主播，间隔 ${config.interval || 60}s`)
  }

  // ===== 命令 =====
  ctx.command('douyin', '抖音直播监控')
    .action(() =>
      '抖音直播开播/下播提醒\n' +
      '配置方法：插件设置页 → 添加主播\n' +
      'douyin.list — 查看当前监控状态\n' +
      'douyin.check — 手动查询一次\n' +
      'douyin.debug <账号> — 查看 API 原始响应'
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

  ctx.command('douyin.debug <account>', '查看 API 原始响应')
    .action(async ({ session }, account) => {
      if (!account) return '请提供抖音账号，用法: douyin.debug 323812413279'
      try {
        const url = `https://live.douyin.com/webcast/room/web/enter/?aid=6383&device_platform=web&enter_from=web_live&cookie_enabled=true&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=120.0.0.0&web_rid=${account}`
        const raw = await ctx.http.get(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Cookie': cookieStr, 'Referer': `https://live.douyin.com/${account}` },
          responseType: 'text', timeout: 10000,
        })
        if (!raw || raw.length < 10) return `响应过短(${raw ? raw.length : 0}字节)`
        const json = JSON.parse(raw)
        const inner = json.data || json
        return `status_code=${inner.status_code}\nroom_status=${inner.room_status}\ndataCount=${inner.data?.length || 0}\n${raw.substring(0, 400)}`
      } catch (e) {
        return `错误: ${e.message}`
      }
    })

  // 启动监控
  start()

  // 清理
  ctx.on('dispose', () => {
    if (timer) clearInterval(timer)
  })
}

module.exports = { Config, apply }
