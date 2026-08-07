import c from "chalk"
import fs from "fs"
import p from "path"
import EventEmitter from "events"
import similarity from 'similarity'
import { own } from '../system/helper.js'
import { fileURLToPath } from 'url'
import middleware from '../system/middleware.js'
import getMessageContent from '../system/msg.js'
import { getGc, stats, saveDb, saveDbDebounced, markDirty } from '../system/db/data.js'
import { ocrs } from './ocrs.js'
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { downloadMediaMessage } = require('@adiwajshing/baileys');
let _taxFn = null;
import('../system/function.js').then(m => _taxFn = m._tax).catch(() => {});

const __filename = fileURLToPath(import.meta.url)
const dirname = p.dirname(__filename)

const dir = p.join(dirname, "command")
const pluginsDir = p.join(dirname, "plugins")

class CommandEmitter extends EventEmitter {
  constructor() {
      super()
      this.commands = new Map()
      this.regexCommands = []
      this.allPlugins = []
  }
  
  on(def) {
    if (typeof def !== "object" || (!def.cmd && !def.command) || !def.run) return
    
    // Normalize properties
    def.cmd = def.cmd || def.command
    def.name = def.name || (Array.isArray(def.cmd) ? def.cmd[0] : undefined)
    
    const cmdList = Array.isArray(def.cmd) ? def.cmd : [def.cmd]
    cmdList.forEach(c => {
        if (c instanceof RegExp) {
            this.regexCommands.push({ ...def, regex: c })
        } else {
            this.commands.set(String(c).toLowerCase(), def)
        }
    })
    this.allPlugins.push(def)
  }

  find(cmdStr, text) {
      if (!cmdStr) return null
      const lower = cmdStr.toLowerCase()

      let found = this.commands.get(lower)
      if (found) return found

      return this.regexCommands.find(r => r.regex.test(lower) || r.regex.test(text))
  }
}

const ev = new CommandEmitter()

const unloadByFile = file => {
  if (!file) return
  for (let [k, v] of ev.commands.entries()) {
      if (v.file === file) ev.commands.delete(k)
  }
  ev.regexCommands = ev.regexCommands.filter(x => x.file !== file)
  ev.allPlugins = ev.allPlugins.filter(x => x.file !== file)
}

const loadFile = async (rootDir, f, isReload = !0) => {
  try {
    const fp = p.join(rootDir, f),
          moduleUrl = `${fp}?update=${Date.now()}`
    
    if (isReload) unloadByFile(f)
    
    // Import Module with Error Handling
    let mod;
    try {
        mod = await import(moduleUrl).then(m => m.default || m)
    } catch (importErr) {
        console.error(c.red.bold(`[LOAD FAIL] Failed to import ${f}:`), importErr.message)
        return
    }
    
    if (!mod) return

    const isPlugin = rootDir.endsWith('plugins')
    const type = isPlugin ? 'plugin' : 'command'

    // --- ADAPTER: HANDLER STYLE (New) ---
    if (mod.command || mod.cmd) {
        const cmdDef = {
            file: f,
            type: type,
            cmd: mod.command || mod.cmd,
            tags: mod.tags,
            desc: mod.help,
            limit: mod.limit,
            premium: mod.premium,
            cooldown: mod.cooldown,
            prefix: mod.prefix,
            owner: mod.owner || mod.rowner,
            group: mod.group,
            admin: mod.admin,
            botAdmin: mod.botAdmin,
            before: mod.before, // STORE BEFORE HOOK
            run: async (xp, m, extra) => {
                return mod(m, {
                    conn: xp,
                    text: extra.args.join(' '),
                    usedPrefix: extra.prefix,
                    command: extra.command,
                    args: extra.args,
                    isOwner: extra.isOwner,
                    isAdmin: extra.isAdmin,
                    isBotAdmin: extra.isBotAdmin,
                    groupMetadata: extra.groupMetadata,
                    participants: extra.participants,
                    ...extra
                })
            }
        }
        ev.on(cmdDef)
        return
    }

    // --- ADAPTER: STANDARD STYLE (Old) ---
    if (typeof mod === "function") {
        const originalOn = ev.on.bind(ev)
        ev.on = (def) => {
            if (typeof def === 'object') {
                def.file = f
                def.type = type
            }
            originalOn(def)
        }
        mod(ev)
        ev.on = originalOn
    }

  } catch (e) {
    console.error(`error pada loadFile ${f}`, e)
  }
}

const getAllFiles = (dirPath, arrayOfFiles = [], baseDir = dirPath) => {
  if (!fs.existsSync(dirPath)) return arrayOfFiles
  const files = fs.readdirSync(dirPath)
  files.forEach((file) => {
    const fullPath = p.join(dirPath, file)
    if (fs.statSync(fullPath).isDirectory()) {
      getAllFiles(fullPath, arrayOfFiles, baseDir)
    } else {
      if (file.endsWith('.js')) {
          arrayOfFiles.push(p.relative(baseDir, fullPath))
      }
    }
  })
  return arrayOfFiles
}

const loadAll = async () => {
  const cmds = getAllFiles(dir)
  for (const f of cmds) await loadFile(dir, f, !0)

  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir)
  const plugins = getAllFiles(pluginsDir)
  for (const f of plugins) await loadFile(pluginsDir, f, !0)

  console.log(c.greenBright.bgGrey.bold(`Berhasil memuat total ${ev.allPlugins.length} cmd`))
}

const watch = () => {
  const watchDir = (targetDir) => {
      const debounceTimers = {}
      if (!fs.existsSync(targetDir)) return
      try {
          fs.watch(targetDir, { recursive: true }, (event, f) => {
              if (!f || !f.endsWith(".js")) return
              clearTimeout(debounceTimers[f])
              debounceTimers[f] = setTimeout(() => {
                  console.log(c.cyanBright.bold(`${targetDir === pluginsDir ? '[PLUGIN]' : '[CMD]'} ${f} Updated`))
                  loadFile(targetDir, f, !0)
              }, 3e2)
          })
      } catch (e) {
          const files = getAllFiles(targetDir)
          for (const f of files) {
              fs.watchFile(p.join(targetDir, f), () => {
                  loadFile(targetDir, f, !0)
              })
          }
      }
  }
  watchDir(dir)
  watchDir(pluginsDir)
}

const handleCmd = async (m, xp, store) => {
  let id;
  try {
    // --- 0. IGNORE STATUS & BROADCAST (CRITICAL FIX) ---
    if (m.key.remoteJid === 'status@broadcast') return
    if (m.message?.protocolMessage || m.message?.senderKeyDistributionMessage) return

    // --- 1. ENRICH MESSAGE OBJECT ---
    const { text } = getMessageContent(m) || {}
    
    id = m.key.remoteJid 
    if (!id) return 

    // --- 2. PARSE PREFIX & COMMAND ---
    const pfx = [].concat(global.prefix),
          pre = pfx.find(p => text && text.startsWith(p)),
          usedPrefix = pre || '',
          cmdText = pre ? text.slice(pre.length).trim() : (text || '').trim(),
          [cmd, ...args] = cmdText.split(/\s+/),
          lowerCmd = cmd?.toLowerCase()

    // --- OCR SYSTEM (NEW) ---
    if (await ocrs(xp, m)) return

    // --- 3. FIND COMMAND DATA (FAST MAP LOOKUP) ---
    const eventData = ev.find(lowerCmd, cmdText)

    // --- PREFIX VALIDATION (EARLY) ---
    // Identify if this is potentially a command
    let isPotentialCommand = !!pre || (eventData && (eventData.prefix === false))

    // --- 4. RUN MIDDLEWARE ---
    // Pass eventData only if it's a potential command to avoid middleware side effects on plain text
    const mw = await middleware(xp, m, lowerCmd || '', isPotentialCommand ? (eventData || {}) : {})
    if (!mw.next) return

    // Re-inject middleware results to 'm' (Avoiding read-only getter conflicts)
    Object.defineProperty(m, 'isAdmin', { value: mw.data.isAdmin, enumerable: true, configurable: true, writable: true })
    Object.defineProperty(m, 'isBotAdmin', { value: mw.data.isBotAdmin, enumerable: true, configurable: true, writable: true })
    
    // --- 5. EXECUTE 'BEFORE' HOOKS (Interceptors) ---
    for (const plugin of ev.allPlugins) {
        if (typeof plugin.before === 'function') {
            try {
                const stop = await plugin.before(m, { 
                    conn: xp, 
                    ...mw.data, 
                    args,
                    command: lowerCmd,
                    prefix: usedPrefix,
                    text: text,
                    store: store
                })
                if (stop === true) return 
            } catch (e) {
                console.error(`[BEFORE ERROR] ${plugin.file}:`, e)
            }
        }
    }

    // --- 6. COMMAND PROCESSING ---
    if (!lowerCmd) return

    // --- SIMILARITY CHECK (ONLY IF PREFIX USED) ---
    if (!eventData && pre && pre !== '') {
        const gcData = getGc(id)
        if (gcData?.mute && !own(m)) return
        const allCmds = Array.from(ev.commands.keys())
        if (allCmds.length > 0) {
            const matches = allCmds.map(c => ({ name: c, score: similarity(lowerCmd, c) }))
            const bestMatches = matches.filter(m => m.score > 0.5).sort((a, b) => b.score - a.score).slice(0, 3)
            if (bestMatches.length > 0) {
                let txt = `❓ *COMMAND TIDAK DITEMUKAN*\nMungkin maksud Anda:`
                bestMatches.forEach((match, i) => {
                    txt += `\n${i+1}. *${usedPrefix}${match.name}* (${Math.floor(match.score * 100)}%)`
                })
                return xp.sendMessage(id, { text: txt }, { quoted: m })
            }
        }
        return m.reply(`❌ *COMMAND TIDAK DIKENAL*\n\nKetik *${usedPrefix}menu* untuk melihat daftar fitur.`)
    }

    // If not a command and no similarity found, just exit
    if (!eventData) return

    // --- PREFIX VALIDATION (STRICT) ---
    let needPrefix = eventData.prefix ?? true
    const isRegex = eventData.regex || eventData.cmd instanceof RegExp
    if (isRegex && eventData.prefix === undefined) needPrefix = false
    
    if (needPrefix === true && !pre) return

    // Update 'm' with event specific data
    m.isCommand = true
    m.plugin = eventData.file || 'unknown'
    
    if (mw.data.user) {
        m.exp = mw.data.user.exp
        m.limit = mw.data.user.limit
    }

    if (mw.data.limitExceeded) {
        return m.reply(`⚠️ *LIMIT HABIS* ⚠️\nLimit harian kamu habis. Tunggu besok atau beli di .shop`)
    }

    if (eventData.premium && !mw.data.user?.premium && !mw.data.isOwner) {
        return m.reply('💎 *PREMIUM ONLY* 💎\n\nFitur ini khusus untuk user premium. Hubungi owner untuk upgrade.')
    }

    // --- 7. EXECUTE MAIN COMMAND ---
    try {
        // --- LIMIT CONSUMPTION (NEW) ---
        // Kurangi limit hanya jika command BENAR-BENAR akan dijalankan
        if (mw.data.consumeLimit && mw.data.user) {
             mw.data.user.limit -= 1
             saveDbDebounced()
        }
        
        // --- TAX SYSTEM (NEW) ---
        if (typeof _taxFn === 'function') {
            const tax = await _taxFn(xp, m)
            if (tax > 0 && mw.data.user && mw.data.user.money >= tax) {
                mw.data.user.money -= tax
                saveDbDebounced()
            }
        }

        await eventData.run(xp, m, { 
            conn: xp,
            ...mw.data, 
            args,
            command: lowerCmd,
            prefix: usedPrefix,
            usedPrefix: usedPrefix,
            text: args.join(' '),
            store: store
        })
        
        // --- STATS (SUCCESS) ---
        try {
            const dbStats = stats()
            if (!dbStats.plugin) dbStats.plugin = {}
            if (!dbStats.plugin[lowerCmd]) dbStats.plugin[lowerCmd] = { total: 0, success: 0, last: 0 }
            dbStats.plugin[lowerCmd].total += 1
            dbStats.plugin[lowerCmd].success += 1
            dbStats.plugin[lowerCmd].last = Date.now()
            markDirty('stats')
        } catch {}

    } catch (e) {
        console.error(`[EXEC ERROR] ${eventData.file}`, e)
        
        // --- STATS (FAIL) ---
        try {
            const dbStats = stats()
            if (dbStats?.plugin?.[lowerCmd]) dbStats.plugin[lowerCmd].total += 1
        } catch {}

        // Error Report
        await xp.sendMessage(id, { text: `❌ *SYSTEM ERROR*\n\nTerjadi kesalahan pada fitur: *${lowerCmd}*\nLaporan dikirim.` }, { quoted: m })
        const report = `🚨 *ERROR REPORT*\n📂 File: ${eventData.file}\n👤 Sender: @${m.sender.split('@')[0]}\n💻 Cmd: ${usedPrefix}${lowerCmd}\n📄 Err: ${e.stack || e.message}`
        const owner = global.ownerNumber?.[0]?.replace(/\D/g, '') + '@s.whatsapp.net'
        if (owner) await xp.sendMessage(owner, { text: report, mentions: [m.sender] })
    }

  } catch (e) {
    console.error('Fatal Error handleCmd:', e)
  }
}

// REMOVED TOP-LEVEL AWAIT TO PREVENT HANG DURING IMPORT

global.reloadPlugins = async () => {
    ev.commands.clear()
    ev.regexCommands = []
    ev.allPlugins = []
    await loadAll()
    return true
}

export { handleCmd, loadAll, ev, watch }