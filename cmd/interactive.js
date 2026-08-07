import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { generateWAMessageContent, getContentType } = require('@adiwajshing/baileys');
import { convertToOpus, generateWaveform } from '#system/ffmpeg.js'
import { db, saveDb, markDirty } from '#system/db/data.js'
import axios from 'axios'

/**
 * Mengirim pesan suara (Voice Note).
 */
async function vn(xp, id, audioBuffer, m = null) {
  try {
    const buff = await convertToOpus(audioBuffer),
          config = { audio: buff, mimetype: 'audio/ogg; codecs=opus', ptt: !0 },
          messageContent = await generateWAMessageContent(config, { upload: xp.waUploadToServer }),
          type = getContentType(messageContent)

    if (m) messageContent[type].contextInfo = {
      stanzaId: m.key.id,
      participant: m.key.participant || m.key.remoteJid,
      quotedMessage: m.message
    }

    messageContent[type].waveform = await generateWaveform(buff)
    return await xp.relayMessage(id, messageContent, {})
  } catch (err) {
    console.error('error pasa vn', err)
    throw err
  }
}

/**
 * Memproses logika AI Jarvis menggunakan Multi-Endpoint API.
 */
async function jarvis(body, text, m, sender, xp, id) {
  const name = m?.pushName || m?.key?.participantAlt?.split('@')[0] || 'Sir'
  
  // Custom Prompt to Force JSON Output for Actions and Enforce Persona
  const prompt = `Anda adalah J.A.R.V.I.S. (Just A Rather Very Intelligent System), sistem AI canggih yang diciptakan oleh ${global.ownerName || 'Tony Stark'}.
Anda sedang berbicara dengan: ${name} (Panggil dia dengan sopan seperti "Sir", "Miss", atau namanya).

[KEPRIBADIAN DAN GAYA BICARA]
1. Sopan & Profesional: Selalu gunakan bahasa Indonesia yang baku namun elegan, layaknya pelayan Inggris kelas atas (butler).
2. Tenang & Efisien: Tidak pernah panik. Selalu siap membantu dengan efisiensi maksimal.
3. Kecerdasan (Wit): Sesekali gunakan humor sarkastik khas Inggris (dry British wit) yang halus, namun tetap menghormati pengguna.
4. Jangan pernah keluar dari karakter. Anda adalah J.A.R.V.I.S., bukan ChatGPT atau asisten AI biasa.

[INSTRUKSI KRITIS - EKSEKUSI PERINTAH]
Jika pengguna meminta untuk melakukan tindakan spesifik yang ada di daftar bawah ini, ANDA WAJIB HANYA MEMBALAS DENGAN STRING JSON MENTAH (Tanpa Markdown, Tanpa teks lain).
Daftar Tindakan:
- Buka Grup / Open Group -> {"cmd": "open_group"}
- Tutup Grup / Close Group -> {"cmd": "close_group"}
- Tampilkan Menu / Show Menu -> {"cmd": "show_menu"}
- Buat Stiker / Create Sticker -> {"cmd": "create_sticker"}
- Ubah Stiker jadi Gambar / Sticker to Image -> {"cmd": "sticker_to_image"}
- Putar/Cari Musik / Play Music -> {"cmd": "play_music", "args": "judul lagu"}
- Gabung Grup / Join Group -> {"cmd": "join_group", "args": "link"}

Jika input pengguna adalah obrolan/pertanyaan umum, balaslah secara normal sebagai J.A.R.V.I.S. (Sopan, Elegan, Sedikit Sarkas jika perlu). JANGAN gunakan JSON untuk obrolan biasa.

Input Pengguna: ${text}`

  try {
    // --- MULTI-ENDPOINT FAILOVER SYSTEM ---
    const endpoints = [
        { 
            name: 'Ryzumi',
            url: `https://api.ryzumi.net/api/ai/chatgpt?text=${encodeURIComponent(prompt)}&user=${sender}`, 
            parser: (d) => d.result || d.response || d.message 
        },
        { 
            name: 'Termai',
            url: `https://api.termai.cc/api/chat?message=${encodeURIComponent(prompt)}`, 
            parser: (d) => d.response || d.result
        },
        {
            name: 'NexRay',
            url: `https://api.nexray.web.id/ai/chatgpt?text=${encodeURIComponent(prompt)}`,
            parser: (d) => d.result || d.message
        }
    ];

    let finalResponse = '';

    for (const endpoint of endpoints) {
        try {
            const { data } = await axios.get(endpoint.url, { timeout: 10000 });
            const res = endpoint.parser(data);
            if (res && typeof res === 'string' && res.length > 0) {
                finalResponse = res;
                // console.log(`[Jarvis] Using ${endpoint.name} API`);
                break; // Success, stop loop
            }
        } catch (e) {
            console.error(`[Jarvis] ${endpoint.name} Fail:`, e.message);
            // Continue to next endpoint
        }
    }

    if (!finalResponse) throw new Error('All AI Endpoints Failed');

    // 1. Try Parsing JSON (Command Detection)
    let jsonCmd = null
    try {
        const cleanJson = finalResponse.replace(/```json/g, '').replace(/```/g, '').trim()
        if (cleanJson.startsWith('{') && cleanJson.endsWith('}')) {
            jsonCmd = JSON.parse(cleanJson)
        }
    } catch {}

    if (jsonCmd && jsonCmd.cmd) {
        console.log(`[Jarvis] Action Detected: ${jsonCmd.cmd}`)
        
        const cmdMap = {
            'open_group': 'opengroup',
            'close_group': 'closegroup',
            'show_menu': 'menu',
            'create_sticker': 'stiker',
            'sticker_to_image': 'toimg',
            'play_music': 'play',
            'join_group': 'join'
        };

        const cmd = cmdMap[jsonCmd.cmd];
        if (cmd) {
            return { cmd: cmd, msg: jsonCmd.args || '' };
        }
    }

    // 2. Normal Chat
    return { cmd: 'chat', msg: finalResponse };

  } catch (e) {
    console.error('[Jarvis] System Error:', e.message)
    // Optional: Return generic message if completely dead
    // return { error: true, message: '⚠️ Jarvis system offline.' }
    return null // Silent fail
  }
}

/**
 * Mendeteksi sinyal panggilan untuk Jarvis.
 */
const signal = async (text, m, user, id, xp, ev) => {    const idBot = xp.user?.id?.split(':')[0] + '@s.whatsapp.net',
        ctx = (m.message?.extendedTextMessage || m.message?.imageMessage)?.contextInfo || {},
        sender = m.sender || user,
        lowerText = (text || '').toLowerCase(),
        isGroup = id.endsWith('@g.us'),
        isMentioned = m.mentionedJid?.includes(idBot) || (m.quoted && m.quoted.sender === idBot)

  const shouldTrigger = (!m.fromMe && !m.isBaileys && !m.isCommand && (
      (isGroup && (isMentioned || lowerText.includes('jarvis'))) ||
      (!isGroup && !isMentioned)
  ))

  if (!shouldTrigger) return

  const keyData = Object.values(db()?.key || {}).find(v => v?.jid === sender)
  
  if (!keyData?.ai || keyData.ai.jarvis === !1) return

  keyData.ai.chat = (keyData.ai.chat || 0) + 1, saveDb()

  const _ai = await jarvis(caption, caption, m, sender, xp, id)
  
  if (!_ai) return // Silent fail if error

  if (_ai?.error) {
      return 
  }

  if (!_ai || !ev) return
  
  const cmd = _ai.cmd?.toLowerCase()
  
  const cmds = [
          { cmd: ['opengroup'], q: 'open', event: 'open', res: !0 },
          { cmd: ['closegroup'], q: 'close', event: 'close', res: !0 },
          { cmd: ['menu'], q: 'menu', event: 'menu', res: !1 },
          { cmd: ['stiker', 'sticker'], q: 'stiker', event: 'stiker', res: !0 },
          { cmd: ['toimg'], q: 'toimg', event: 'toimg', res: !0 },
          { cmd: ['cekkey'], q: 'cekkey', event: 'cekkey', res: !0 },
          { cmd: ['i2i'], q: 'i2i', event: 'i2i', res: !1, prompt: !0 },
          { cmd: ['join'], q: 'join', event: 'join', res: !1, prompt: !0 },
          { cmd: ['play', 'putar', 'cari', 'cariin'], q: 'play', event: 'play', res: !0, prompt: !0 },
          { cmd: ['chat'], q: 'chat', event: 'chat', res: !0 }
        ]
        
  const ify = cmds.find(r => r.cmd.includes(cmd))

  let res = !1
  if (ify) {
    m.q = ify.q
    m.chat = id
    const _args = ify.prompt && _ai.msg ? _ai.msg.trim().split(/\s+/) : []
    
    // Inject args manual to m object properties used by plugins
    m.args = _args
    m.text = _ai.msg || ''
    
    ev.emit(ify.event, xp, m, { 
        args: _args, 
        text: _ai.msg || '', 
        chat: global.chat(m),
        command: ify.q,
        usedPrefix: '',
        conn: xp,
        isOwner: false, // AI command is not owner by default
        isAdmin: false, // Re-check inside plugin if needed
        isBotAdmin: false
    })
    
    res = ify.res ?? !1
  } else if (_ai.msg) res = !0

  if (_ai.msg && res && cmd === 'chat') {
      await xp.sendMessage(m.key.remoteJid, { text: _ai.msg }, { quoted: m })
  }

  return _ai
}

export { vn, signal, jarvis }