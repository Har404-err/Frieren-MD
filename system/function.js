import crypto from 'crypto'
import fetch from 'node-fetch'
import fs from 'fs'
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { prepareWAMessageMedia, generateWAMessageFromContent, generateWAMessage, proto } = require('@adiwajshing/baileys');
import { jarvis } from '../cmd/interactive.js'
import { tmpFiles } from './tmpfiles.js'
import { db, saveDb, lid, markDirty } from './db/data.js'

const memoryCache = {},
      groupCache = new Map()

let imgCache = {}

async function _imgTmp() {
  const thumbPath = './media/frieren-thumb.jpg'
  if (!fs.existsSync(thumbPath)) return

  const img = fs.readFileSync(thumbPath)

  if (!img || imgCache.url) {
    if (!img) return

    const res = imgCache.url ? await fetch(imgCache.url,{method:'HEAD'}).catch(() => !1) : null
    if (res && res.ok) return imgCache.url
    if (imgCache.url) delete imgCache.url
  }

  return imgCache.url = await tmpFiles(img)
}

async function _tax(xp, m) {
  const chat = global.chat(m),
        userKey = Object.keys(db().key || {}).find(k => db().key[k]?.jid === (chat?.sender || m.sender)),
        usrDb = userKey ? db().key[userKey] : null,
        tax = 1, // Default 1% tax
        money = usrDb?.money || 0

  return Math.floor(money * tax / 100)
}

async function getMetadata(id, xp, retry = 2) {
  if (groupCache.has(id)) return groupCache.get(id)
  try {
    const m = await xp.groupMetadata(id)
    groupCache.set(id, m)
    setTimeout(() => groupCache.delete(id), 12e4)
    return m
  } catch (e) {
    return retry > 0
      ? (await new Promise(r => setTimeout(r, 1e3)), getMetadata(id, xp, retry - 1))
      : null
  }
}

async function saveLidCache(metadata) {
  if (!global.lidReverseMap) global.lidReverseMap = new Map()
  for (const p of metadata?.participants || []) {
    const lidId = p.lid || (p.id?.endsWith('@lid') ? p.id : null)
    const pnJid = p.phoneNumber || p.pnJid || (p.id?.endsWith('@s.whatsapp.net') ? p.id : null)
    
    if (lidId && pnJid) {
      global.lidReverseMap.set(lidId, pnJid)
    }
  }
}

function replaceLid(m) {
  if (!m || !global.lidReverseMap) return m
  
  const resolveLidMentions = (text) => {
    if (typeof text !== 'string') return text
    return text.replace(/@(\d+)@lid/g, (_, num) => {
      const resolved = global.lidReverseMap.get(`${num}@lid`)
      return resolved ? `@${resolved.split('@')[0]}` : `@${num}@lid`
    })
  }

  // Handle message text fields
  if (m.message?.extendedTextMessage?.text) {
    m.message.extendedTextMessage.text = resolveLidMentions(m.message.extendedTextMessage.text)
  }
  if (m.message?.conversation) {
    m.message.conversation = resolveLidMentions(m.message.conversation)
  }
  // Handle caption fields
  if (m.message?.imageMessage?.caption) {
    m.message.imageMessage.caption = resolveLidMentions(m.message.imageMessage.caption)
  }
  if (m.message?.videoMessage?.caption) {
    m.message.videoMessage.caption = resolveLidMentions(m.message.videoMessage.caption)
  }
  if (m.message?.documentMessage?.caption) {
    m.message.documentMessage.caption = resolveLidMentions(m.message.documentMessage.caption)
  }
  return m
}

async function call(xp, error, m) {
  try {
    const errMsg = (typeof error === 'string' ? error : error?.stack || error?.message || String(error))
            .replace(/file:\/\/\/[^\s)]+/g, '')
            .replace(/at\s+/g, '\n→ ')
            .trim(),
          sender = m?.key?.participant || m?.participant || m?.sender || 'unknown',
          chatId = m?.chat || m?.key?.remoteJid || sender,
          prompt = `Tolong bantu jelaskan error ini dengan bahasa alami dan ramah pengguna:\n\n${errMsg}`,
          res = await jarvis(prompt, prompt, m, sender, xp, chatId)

    res?.msg
      ? await xp.sendMessage(chatId, { text: res.msg }, { quoted: m })
      : await xp.sendMessage(chatId, { text: `Gagal memproses error: ${res?.message || 'tidak diketahui'}` }, { quoted: m })
  } catch (errSend) {
    await xp.sendMessage(
      m?.chat || m?.key?.remoteJid || 'unknown',
      { text: `Gagal menjalankan call(): ${errSend?.message || String(errSend)}` },
      { quoted: m }
    )
  }
}

const cleanMsg = (obj, seen = new WeakSet()) => {
  if (obj == null) return obj
  if (typeof obj === 'object') {
    if (seen.has(obj)) return undefined
    if (!(Buffer.isBuffer(obj) || ArrayBuffer.isView(obj))) seen.add(obj)

    if (Array.isArray(obj)) {
      const arr = obj.map(v => cleanMsg(v, seen)).filter(v => v !== undefined)
      return arr.length ? arr : undefined
    }
    
    if (Buffer.isBuffer(obj) || ArrayBuffer.isView(obj)) return obj
    
    const cleaned = Object.entries(obj).reduce((acc, [k, v]) => {
      const c = cleanMsg(v, seen)
      if (c !== undefined) acc[k] = c
      return acc
    }, {})
    return Object.keys(cleaned).length ? cleaned : undefined
  }
  return obj
}

async function func() {
  const url = 'https://raw.githubusercontent.com/MaouDabi0/Dabi-Ai-Documentation/main/assets/func.js',
        code = await fetch(url).then(r => r.text()),
        data = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64'),
        md = await import(data),
        funcs = md.default

  return Object.assign(global, funcs), funcs
}

async function sendIAMessage(xp, jid, buttons = [], content = {}, options = {}) {
  let msgContent = {
    viewOnceMessage: {
      message: {
        messageContextInfo: {
          deviceListMetadata: {},
          deviceListMetadataVersion: 2
        },
        interactiveMessage: proto.Message.InteractiveMessage.create({
          body: proto.Message.InteractiveMessage.Body.create({ text: content.body || '' }),
          footer: proto.Message.InteractiveMessage.Footer.create({ text: content.footer || '' }),
          header: proto.Message.InteractiveMessage.Header.create({
            title: content.title || '',
            subtitle: content.subtitle || '',
            hasMediaAttachment: !!content.media
          }),
          nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons: buttons
          })
        })
      }
    }
  }

  if (content.media) {
    try {
      const mediaType = content.mediaType || 'image'
      const mediaPayload = typeof content.media === 'string' && content.media.startsWith('http') 
        ? { url: content.media } 
        : content.media

      const mediaMessage = await prepareWAMessageMedia(
        { [mediaType]: mediaPayload },
        { upload: xp.waUploadToServer }
      )
      msgContent.viewOnceMessage.message.interactiveMessage.header = {
        ...msgContent.viewOnceMessage.message.interactiveMessage.header,
        ...mediaMessage
      }
    } catch (e) {
      console.error('Failed to attach media in sendIAMessage:', e.message)
      msgContent.viewOnceMessage.message.interactiveMessage.header.hasMediaAttachment = false
    }
  }

  const msg = generateWAMessageFromContent(jid, msgContent, options)
  return await xp.relayMessage(jid, msg.message, { messageId: msg.key.id })
}

/**
 * Enhanced Sticker Pack Sender using Interactive Carousel
 * Displays stickers as a swipeable list for better UX
 */
async function sendStickerPack(xp, jid, packData = {}, options = {}) {
    const { name, publisher, stickers, slug } = packData
    if (!stickers || stickers.length === 0) return

    const p = global.prefix[0] || '.'
    const title = name || 'FrierenBot Sticker Pack'
    const author = publisher || 'FrierenBot'
    const baseUrl = 'https://s3.getstickerpack.com/'

    const cards = []
    const limit = Math.min(stickers.length, 10)

    for (let i = 0; i < limit; i++) {
        const s = stickers[i]
        const imgUrl = typeof s === 'string' ? s : (s.url ? (s.url.startsWith('http') ? s.url : baseUrl + s.url) : '')
        
        if (!imgUrl) continue

        cards.push({
            header: {
                title: `[ ${i + 1} / ${stickers.length} ]`,
                hasMediaAttachment: true,
                ...(await prepareWAMessageMedia({ image: { url: imgUrl } }, { upload: xp.waUploadToServer }))
            },
            body: { text: `Sticker dari pack: *${title}*` },
            footer: { text: `By ${author}` },
            nativeFlowMessage: {
                buttons: [
                    {
                        name: "cta_url",
                        buttonParamsJson: JSON.stringify({
                            display_text: "🔗 Open in Browser",
                            url: slug ? `https://getstickerpack.com/stickers/${slug}` : imgUrl
                        })
                    }
                ]
            }
        })
    }

    const msgContent = {
        viewOnceMessage: {
            message: {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: {
                    body: { text: `📦 *STICKER PACK: ${title}*\n👤 *Author:* ${author}\n🔢 *Total:* ${stickers.length} stiker\n\n_Silakan geser untuk melihat preview. Gunakan perintah di bawah untuk mengambil semua._` },
                    footer: { text: global.botName },
                    header: { title: `✨ ${title} ✨`, hasMediaAttachment: false },
                    carouselMessage: { cards },
                    nativeFlowMessage: {
                        buttons: [
                            {
                                name: "quick_reply",
                                buttonParamsJson: JSON.stringify({
                                    display_text: "📥 GET ALL STICKERS (ZIP)",
                                    id: `${p}getwa ${slug || name}`
                                })
                            }
                        ]
                    }
                }
            }
        }
    }

    const msg = generateWAMessageFromContent(jid, msgContent, { ...options, userJid: xp.user.id })
    return await xp.relayMessage(jid, msg.message, { messageId: msg.key.id })
}

async function sendAlbumMessage(xp, jid, mediaItems = [], content = {}, options = {}) {
    const opener = await generateWAMessageFromContent(
        jid,
        {
            messageContextInfo: { messageSecret: crypto.randomBytes(32) },
            albumMessage: {
                expectedImageCount: mediaItems.filter(m => m.type === 'image').length,
                expectedVideoCount: mediaItems.filter(m => m.type === 'video').length
            }
        },
        options
    )

    await xp.relayMessage(jid, opener.message, { messageId: opener.key.id })

    for (const item of mediaItems) {
        const mediaType = item.type || 'image'
        const mediaContent = item.media
        const caption = item.caption || ''

        const msg = await generateWAMessage(
            jid,
            { [mediaType]: mediaContent, caption: caption },
            { upload: xp.waUploadToServer }
        )

        msg.message.messageContextInfo = {
            messageSecret: crypto.randomBytes(32),
            messageAssociation: {
                associationType: 1,
                parentMessageKey: opener.key
            }
        }

        await xp.relayMessage(jid, msg.message, { messageId: msg.key.id })
    }
    
    return opener
}

async function sendCarouselMessage(xp, jid, cards = [], content = {}, options = {}) {
  const processedCards = [];
  
  for (const card of cards) {
      let header = {
          title: card.title || '',
          subtitle: card.subtitle || '',
          hasMediaAttachment: false
      };

      if (card.media) {
          try {
              const mediaType = card.mediaType || 'image';
              const mediaPayload = typeof card.media === 'string' && card.media.startsWith('http')
                  ? { url: card.media }
                  : card.media;
              
              const mediaMessage = await prepareWAMessageMedia(
                  { [mediaType]: mediaPayload },
                  { upload: xp.waUploadToServer }
              );
              
              header = { ...header, ...mediaMessage, hasMediaAttachment: true };
          } catch (e) {
              console.error('Failed to prepare media for card:', e);
          }
      }

      processedCards.push({
          body: proto.Message.InteractiveMessage.Body.create({ text: card.body || '' }),
          footer: proto.Message.InteractiveMessage.Footer.create({ text: card.footer || '' }),
          header: proto.Message.InteractiveMessage.Header.create(header),
          nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
              buttons: card.buttons || []
          })
      });
  }

  let msgContent = {
    viewOnceMessage: {
      message: {
        messageContextInfo: {
          deviceListMetadata: {},
          deviceListMetadataVersion: 2
        },
        interactiveMessage: proto.Message.InteractiveMessage.create({
          body: proto.Message.InteractiveMessage.Body.create({ text: content.body || '' }),
          footer: proto.Message.InteractiveMessage.Footer.create({ text: content.footer || '' }),
          header: proto.Message.InteractiveMessage.Header.create({
              title: content.title || '',
              subtitle: content.subtitle || '',
              hasMediaAttachment: false
          }),
          carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.create({
            cards: processedCards
          })
        })
      }
    }
  }
  const msg = generateWAMessageFromContent(jid, msgContent, options)
  return await xp.relayMessage(jid, msg.message, { messageId: msg.key.id })
}

function runtime(seconds) {
	seconds = Number(seconds);
	var d = Math.floor(seconds / (3600 * 24));
	var h = Math.floor(seconds % (3600 * 24) / 3600);
	var m = Math.floor(seconds % 3600 / 60);
	var s = Math.floor(seconds % 60);
	var dDisplay = d > 0 ? d + (d == 1 ? " day, " : " days, ") : "";
	var hDisplay = h > 0 ? h + (h == 1 ? " hour, " : " hours, ") : "";
	var mDisplay = m > 0 ? m + (m == 1 ? " minute, " : " minutes, ") : "";
	var sDisplay = s > 0 ? s + (s == 1 ? " second" : " seconds") : "";
	return dDisplay + hDisplay + mDisplay + sDisplay;
}

function getHijriDate() {
    try {
        return new Intl.DateTimeFormat('id-ID', {
            calendar: 'islamic-umalqura',
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        }).format(new Date())
    } catch (e) {
        return 'Hijri Date Unavailable';
    }
}

function resolveJid(user) {
    if (!user) return user;
    if (user.endsWith('@s.whatsapp.net')) return user;
    if (user.endsWith('@lid')) {
        const e = Object.entries(global.lidCache ?? {});
        const p = e.find(([, v]) => v === user)?.[0];
        if (p) return `${p}@s.whatsapp.net`;
    }
    return user;
}

function handleApiError(e) {
    let msg = '❌ Terjadi kesalahan sistem.';
    if (e.response) {
        const status = e.response.status;
        if (status === 404) msg = '❌ Data tidak ditemukan (404). Pastikan link/query benar.';
        else if (status === 401 || status === 403) msg = '❌ Izin ditolak (API Key invalid/expired).';
        else if (status >= 500) msg = '❌ Server API sedang bermasalah (Internal Server Error).';
    }
    if (e.message) {
        if (e.message.includes('ETIMEDOUT') || e.message.includes('timeout')) msg = '❌ Koneksi server timeout. Silakan coba lagi nanti.';
        else if (e.message.includes('ECONNREFUSED')) msg = '❌ Server sedang offline atau sibuk.';
        else if (e.message.includes('ENOTFOUND') || e.message.includes('getaddrinfo')) msg = '❌ Server tidak ditemukan (DNS Error).';
        else if (!msg.includes('404') && !msg.includes('500')) msg = `❌ Error: ${e.message}`;
    }
    return msg;
}

async function filterMsg(m, chat, text) {
  global.cacheCmd ??= []

  if (!chat?.group || !text) return !0

  const id = m.key.remoteJid,
        no = chat.sender,
        jadibot = 'jadibot' in (m.key || {}),
        time = m.messageTimestamp,
        cacheMsg = { id, no, jadibot, text, time },
        same = global.cacheCmd.find(v =>
          v.id === id &&
          v.no === no &&
          v.text === text &&
          v.time === (typeof time === 'object' ? time.low || time : time)
        )

  if (same) {
    if (same.jadibot && !jadibot)
      global.cacheCmd = global.cacheCmd.filter(v => v !== same)

    else if (!same.jadibot && jadibot)
      return !1

    else if (same.jadibot && jadibot) {
      if (Math.random() < 5e-1) return !1
      global.cacheCmd = global.cacheCmd.filter(v => v !== same)
    }

    else return !1
  }

  if (!same && jadibot) {
    global.cacheCmd.push(cacheMsg)

    return await new Promise(resolve => {
      setTimeout(() => {
        const mainExists = global.cacheCmd.find(v =>
          v.id === id &&
          v.no === no &&
          v.text === text &&
          v.time === (typeof time === 'object' ? time.low || time : time) &&
          !v.jadibot
        )

        if (mainExists) {
          global.cacheCmd = global.cacheCmd.filter(v => v !== cacheMsg)
          return resolve(!1)
        }

        resolve(!0)
      }, 5e1)
    })
  }

  global.cacheCmd.push(cacheMsg)

  setTimeout(() => {
    global.cacheCmd = global.cacheCmd.filter(v =>
      !(v.id === id &&
        v.no === no &&
        v.time === (typeof time === 'object' ? time.low || time : time))
    )
  }, 3e5)

  return !0
}

// --- ADMIN & OWNER VALIDATION HELPERS ---

const { areJidsSameUser } = require('@adiwajshing/baileys');

function getAdminStatus(participants, jid) {
    if (!Array.isArray(participants) || !jid) return false;
    const normalize = (id) => id && typeof id === 'string' ? id.split(':')[0] : id;
    const targetJid = normalize(jid);
    const targetNum = targetJid.split('@')[0];

    let pn = targetJid;
    let lidId = targetJid;
    if (global.lidReverseMap) {
        for (let [l, p] of global.lidReverseMap.entries()) {
            if (p === targetJid || p === targetNum || p?.split('@')[0] === targetNum) { lidId = l; break; }
        }
        if (targetJid.endsWith('@lid')) {
            pn = global.lidReverseMap.get(targetJid) || targetJid;
        }
    }

    const checkSame = (id1, id2) => {
        if (!id1 || !id2) return false;
        if (typeof areJidsSameUser === 'function') {
            try { if (areJidsSameUser(id1, id2)) return true; } catch {}
        }
        const n1 = id1.split('@')[0].split(':')[0];
        const n2 = id2.split('@')[0].split(':')[0];
        return n1 === n2;
    };

    const participant = participants.find(p => {
        if (!p || !p.id) return false;
        return checkSame(p.id, targetJid) ||
               checkSame(p.id, pn) ||
               checkSame(p.id, lidId) ||
               (p.phoneNumber && checkSame(p.phoneNumber, pn)) ||
               (p.lid && checkSame(p.lid, lidId));
    });
    return !!(participant?.admin || participant?.isSuperAdmin);
}

async function getPn(jid, xp) {
    if (!jid) return null;

    if (jid.endsWith('@s.whatsapp.net')) return jid.split('@')[0].split(':')[0];

    const user = db().key[jid];
    if (user?.pn) return String(user.pn).replace(/[^0-9]/g, '');

    if (jid.endsWith('@lid') && global.lidReverseMap?.has(jid)) {
        const resolved = global.lidReverseMap.get(jid);
        if (resolved) return resolved.split('@')[0].split(':')[0];
    }

    const mapping = lid().key[jid];
    if (mapping) return mapping.split('@')[0].split(':')[0];

    return null;
}

function getLid(jid) {
    const user = db().key[jid];
    if (user?.lid) return user.lid;

    if (jid.endsWith('@s.whatsapp.net') && global.lidReverseMap) {
        for (let [l, p] of global.lidReverseMap.entries()) {
            if (p === jid) return l;
        }
    }
    return jid;
}

export {
  getMetadata,
  replaceLid,
  saveLidCache,
  call,
  cleanMsg,
  groupCache,
  imgCache,
  func,
  sendIAMessage,
  sendCarouselMessage,
  sendAlbumMessage,
  sendStickerPack,
  runtime,
  getHijriDate,
  resolveJid,
  handleApiError,
  filterMsg,
  _imgTmp,
  _tax,
  getAdminStatus,
  getPn,
  getLid
}
