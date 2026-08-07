import fs from 'fs'
import moment from 'moment-timezone';
import { db, getGc } from './db/data.js'
import { getMetadata, groupCache } from './function.js'
import { normalizeJid } from './msg.js'

const time = {
  timeIndo: (zone = "Asia/Jakarta", fmt = "HH:mm:ss DD-MM-YYYY") => moment().tz(zone).format(fmt)
}

const chat = (m = {}, botName = "pengguna") => {
  const rawId = m?.key?.remoteJid || "",
        id = normalizeJid(rawId),
        group = id.endsWith("@g.us"),
        channel = id.endsWith("@newsletter"),
        rawSender = m?.sender || m?.key?.participantAlt || m?.key?.participant || rawId,
        sender = normalizeJid(rawSender),
        pushName = (m?.pushName || "").trim()
          || (sender.endsWith("@s.whatsapp.net")
            ? sender.replace(/@s\.whatsapp\.net$/, "")
            : botName);

  if (!id) return null;

  return { id, group, channel, sender, pushName };
};

export const banned = jid => {
  const sender = jid,
        dataKeys = Object.keys(db()?.key || {}),
        users = dataKeys.map(k => db().key[k]),
        found = users.find(u => u?.jid === sender);

  let userData = found;

  if (!userData) {
    const clean = sender.replace(/\D/g, ''),
          fallback = users.find(u => u?.jid?.replace(/\D/g, '').endsWith(clean));
    if (fallback) userData = fallback;
  }

  return userData?.ban === !0;
};

export const bangc = chat => {
  const user = chat?.sender,
        owner = (global.ownerNumber || []).map(v => v?.replace(/\D/g, '') || ''),
        target = user?.replace(/\D/g, '') || '',
        gcData = getGc(chat);

  return owner.includes(target) ? !1 : !!(gcData?.ban);
};

export const grupify = async (xp, id, sender) => {
  const meta = groupCache.get(id) || await getMetadata(id, xp) || {};
  if (!meta.id) return {};

  // Helper to clean JID (Remove :1, :2, etc and return only the ID part)
  const clean = (jid) => jid ? jid.split('@')[0].split(':')[0] : ''

  const participants = meta.participants || []
  
  // Ambil semua ID Admin (ID, JID/PN, dan LID)
  const adminIds = new Set()
  participants.forEach(p => {
      if (p.admin) {
          if (p.id) adminIds.add(clean(p.id))
          if (p.jid) adminIds.add(clean(p.jid))
          if (p.lid) adminIds.add(clean(p.lid))
      }
  })
        
  const botJid = xp.user?.id || ''
  const cleanSender = clean(sender)
  const cleanBot = clean(botJid)

  const botAdm = adminIds.has(cleanBot)
  const usrAdm = adminIds.has(cleanSender)

  return {
    meta,
    bot: botJid,
    botAdm,
    usrAdm,
    adm: Array.from(adminIds) 
  };
};

export const txtWlc = async (xp, chat) => {
  try {
    const gcData = getGc(chat)

    const id = chat.id,
          meta = groupCache.get(id) || await getMetadata(id, xp),
          name = meta?.subject || 'Grup'
          
    let desc = meta?.desc?.toString() || 'Tidak ada deskripsi'
    // Batasi panjang deskripsi (Max 150 char) agar tidak spam
    if (desc.length > 150) {
        desc = desc.substring(0, 150) + '... (baca info grup)'
    }

    // Teks Default yang lebih menarik
    let txt = gcData?.filter?.welcome?.welcomeText?.trim()
    
    if (!txt) {
        txt = `╭─── [ *WELCOME* ] ───
│
│ Hai @user 👋
│ Selamat datang di:
│ *${name}*
│
│ _Semoga betah ya!_
╰──────────────────`
    }

    return { txt, meta }
  } catch (e) {
    console.error('txtWlc error:', e)
    return { txt: '' }
  }
}

export const txtLeave = async (xp, chat) => {
  try {
    const gcData = getGc(chat)

    const id = chat.id,
          meta = groupCache.get(id) || await getMetadata(id, xp),
          name = meta?.subject || 'Grup'

    // Teks Default Leave
    let txt = gcData?.filter?.left?.leftText?.trim()
    
    if (!txt) {
        txt = `╭─── [ *GOODBYE* ] ───
│
│ Sayonara @user 👋
│ Telah meninggalkan:
│ *${name}*
│
│ _Nitip gorengan ya kalau balik!_
╰──────────────────`
    }

    return { txt, meta }
  } catch (e) {
    console.error('txtLeave error:', e)
    return { txt: '' }
  }
}

export const mode = (xp, chatData) => {
  if (!chatData) return !1

  const sender = chatData.sender
  const senderNum = sender.replace(/\D/g, ''),
        ownerNum = (global.ownerNumber || []).map(v => v.replace(/\D/g, ''))

  // Check LID reverse map for owner
  const phoneFromLid = global.lidReverseMap?.get(sender) || null
  const phoneFromLidNum = phoneFromLid ? phoneFromLid.split('@')[0] : null

  const isOwner = ownerNum.includes(senderNum) || (phoneFromLidNum && ownerNum.includes(phoneFromLidNum))

  // Owner Selalu Lolos
  if (isOwner) return !0

  // Jika Self Mode (Public = False)
  if (global.public === false) return !1

  // Jika Group Only Mode (GC Only)
  if (global.gconly && !chatData.group && !chatData.channel) return !1

  // Jika Private Only Mode (PC Only)
  if (global.pconly && chatData.group) return !1

  // Default: Lolos
  return !0
}

const sys = {
  time,
  chat,
  grupify
}

export default sys;