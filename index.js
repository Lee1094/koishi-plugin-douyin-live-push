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
  // 方法1: 抓直播间页面 HTML（稳定）
  // 方法2: 直接调 API（需要签名，可能被拦）
  async function checkStreamer(s) {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Cookie': `ttwid=${ttwid}`,
    }

    try {
      // 方法1: 抓直播间页面
      const html = await ctx.http.get(`https://live.douyin.com/${s.account}`, {
        headers,
        responseType: 'text',
        timeout: 10000,
      })

      if (!html || html.length < 100) {
        ctx.logger.warn(`[douyin] "${s.name}" 页面过短(${html ? html.length : 0}字节)`)
        return
      }

      // 从页面提取内嵌数据 —— 用手动括号计数提取完整 JSON 块
      let roomInfo = null
      let roomStatus = null
      let roomTitle = ''
      let coverUrl = ''
      let nickname = s.name
      let avatarUrl = ''

      // 用计数器提取完整 JSON 对象
      const extractJSON = (str, key) => {
        // 尝试多种格式: "key": / "key" : / key:
        const re = new RegExp(`"${key}"\\s*:\\s*`)
        const m = str.match(re)
        if (!m) return null
        let start = m.index + m[0].length
        while (start < str.length && str[start] !== '{' && str[start] !== '[') start++
        if (start >= str.length) return null
        const open = str[start]
        const close = open === '{' ? '}' : ']'
        let depth = 0, i = start
        while (i < str.length) {
          if (str[i] === '\\') { i += 2; continue }
          if (str[i] === open) depth++
          else if (str[i] === close) { depth--; if (depth === 0) break }
          i++
        }
        return str.substring(start, i + 1)
      }

      const roomStoreJSON = extractJSON(html, 'roomStore')
      if (!roomStoreJSON) {
        // 没找到 roomStore，搜其他可能的 key
        const keys = ['roomStore', 'roomInfo', '__INIT_PROPS__', 'RENDER_DATA', 'liveStatus', 'webcast']
        const found = keys.filter(k => html.indexOf(`"${k}"`) > 0)
        ctx.logger.warn(`[douyin] "${s.name}" 未找到 roomStore, 找到的key: ${found.join(',')}`)
        if (found.length === 0) {
          // 打印页面中间部分看看
          const mid = Math.floor(html.length / 2)
          ctx.logger.warn(`[douyin] 页面中间: ${html.substring(mid, mid + 200)}`)
        }
        return
      }

      try {
        const roomStore = JSON.parse(roomStoreJSON)
        roomInfo = roomStore.roomInfo || {}
        roomStatus = roomStore.liveStatus || (roomInfo.room ? roomInfo.room.status : undefined)
        // liveStatus 是字符串: "normal"=未开播, 直播时会变成数字或 "live"
        // roomInfo.room.status 是数字: 2=直播中
      } catch {
        ctx.logger.warn(`[douyin] "${s.name}" roomStore JSON 解析失败`)
        return
      }

      // 检查 roomInfo 是否为空（未开播）
      const hasRoom = roomInfo && roomInfo.room
      if (hasRoom) {
        const room = roomInfo.room
        roomStatus = room.status
        roomTitle = room.title || ''
        coverUrl = (room.cover && room.cover.url_list && room.cover.url_list[0]) || ''
        nickname = (roomInfo.anchor && roomInfo.anchor.nickname) || s.name
        avatarUrl = (roomInfo.anchor && roomInfo.anchor.avatar_thumb && roomInfo.anchor.avatar_thumb.url_list && roomInfo.anchor.avatar_thumb.url_list[0]) || ''
      } else {
        // 未开播
        roomStatus = roomStatus === 'live' ? 2 : 1
      }

      ctx.logger.info(`[douyin] "${s.name}" 状态=${roomStatus} roomInfo=${hasRoom ? '有' : '空'}`)

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
