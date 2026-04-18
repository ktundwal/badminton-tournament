// ============================================================================
// Carnage Courts — Badminton Tournament Engine
// Zero-auth, peer-to-peer. State lives in localStorage; syncs via WebRTC.
// ============================================================================

// Trystero "nostr" strategy: WebRTC signaling over public Nostr relays.
// Unlike the default "torrent" strategy (BitTorrent trackers — often blocked
// by managed-device firewalls and corporate DPI), Nostr uses plain wss://
// connections to general-purpose relay servers, so it passes through
// restrictive networks that block BitTorrent traffic.
import { joinRoom, selfId } from 'https://cdn.jsdelivr.net/npm/@trystero-p2p/nostr@0.23.0/+esm'
import {
  buildSchedule,
  generateRoomName,
  generateTeamName,
  shuffled,
  toDateInputValue
} from './lib/scheduler.mjs'
import { validateScore } from './lib/scoring.mjs'

// ---------------------------------------------------------------------------
// Constants & config
// ---------------------------------------------------------------------------

const APP_ID = 'carnage-courts-v1'
const STATE_VERSION = 1
const DEFAULT_COURTS = 4
const MAX_COURTS = 8
const MIN_COURTS = 1

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

const uid = () => Math.random().toString(36).slice(2, 10)

async function sha256(s) {
  const data = new TextEncoder().encode(s)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const initialState = () => ({
  v: 0,
  schemaVersion: STATE_VERSION,
  createdAt: null,
  updatedAt: null,
  tournamentDate: null,      // ISO YYYY-MM-DD; the day the event happens
  roomId: null,
  pinHash: null,
  pinSalt: null,
  courts: DEFAULT_COURTS,
  players: [],
  teams: null,
  matches: [],
  status: 'lobby'
})

let state = initialState()
let roomHandle = null     // Trystero room
let sendStateAction = null
let getStateAction = null
let peerCount = 0
let myName = localStorage.getItem('cc:myName') || ''

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const LS_STATE = (roomId) => `cc:state:${roomId}`
const LS_PIN   = (roomId) => `cc:pin:${roomId}`

function saveLocal() {
  if (!state.roomId) return
  try {
    localStorage.setItem(LS_STATE(state.roomId), JSON.stringify(state))
  } catch (e) {
    console.warn('localStorage save failed', e)
  }
}

function loadLocal(roomId) {
  try {
    const raw = localStorage.getItem(LS_STATE(roomId))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// P2P sync (Trystero / WebRTC)
// ---------------------------------------------------------------------------

function joinTrysteroRoom(roomId) {
  if (roomHandle) {
    roomHandle.leave()
    roomHandle = null
  }
  setConnStatus('connecting', 'Connecting…')

  try {
    roomHandle = joinRoom({ appId: APP_ID }, roomId)
  } catch (e) {
    console.error('trystero join failed', e)
    setConnStatus('offline', 'Offline (local only)')
    return
  }

  const [sendSt, getSt] = roomHandle.makeAction('state')
  sendStateAction = sendSt
  getStateAction = getSt

  getStateAction((remote, peerId) => {
    if (!remote || typeof remote.v !== 'number') return
    if (remote.v > state.v) {
      state = remote
      saveLocal()
      render()
      toast('Synced from peer')
    } else if (remote.v < state.v) {
      // Peer is behind — push ours back to them
      try { sendStateAction(state, peerId) } catch {}
    }
    // If v === v, assume same state; skip.
  })

  roomHandle.onPeerJoin(peerId => {
    peerCount++
    updatePeerCount()
    setConnStatus('online', 'Online')
    // New peer: send our state so they catch up
    try { sendStateAction(state, peerId) } catch {}
  })

  roomHandle.onPeerLeave(() => {
    peerCount = Math.max(0, peerCount - 1)
    updatePeerCount()
  })

  // Mark as online once the room is successfully constructed
  setConnStatus('online', peerCount > 0 ? 'Online' : 'Online (waiting for peers)')
}

function broadcastState() {
  if (sendStateAction) {
    try { sendStateAction(state) } catch (e) { console.warn('broadcast failed', e) }
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function mutate(fn) {
  const next = structuredClone(state)
  fn(next)
  next.v = (state.v || 0) + 1
  next.updatedAt = Date.now()
  state = next
  saveLocal()
  broadcastState()
  render()
}

async function createRoom({ roomName, pin, tournamentDate }) {
  const salt = uid()
  const pinHash = await sha256(pin + ':' + roomName + ':' + salt)
  state = initialState()
  state.roomId = roomName
  state.pinHash = pinHash
  state.pinSalt = salt
  state.createdAt = Date.now()
  state.updatedAt = state.createdAt
  state.tournamentDate = tournamentDate || toDateInputValue(new Date())
  state.v = 1
  localStorage.setItem(LS_PIN(roomName), pin)  // creator device caches PIN
  saveLocal()
  setRoomInURL(roomName)
  joinTrysteroRoom(roomName)
  // Auto-register the creator if we remember their name — they're clearly
  // playing the tournament they just created.
  if (myName && !state.players.some(p => p.name.toLowerCase() === myName.toLowerCase())) {
    addPlayer(myName)
  }
  render()
}

function addPlayer(name) {
  name = name.trim()
  if (!name) return
  // Trust model: if someone types a name already in the roster, they're
  // claiming their existing slot from another device — not creating a
  // duplicate. Use the canonical casing from the existing entry.
  const existing = state.players.find(p => p.name.toLowerCase() === name.toLowerCase())
  if (existing) {
    myName = existing.name
    localStorage.setItem('cc:myName', myName)
    toast(`Welcome back, ${myName}`)
    render()
    return
  }
  mutate(s => {
    s.players.push({ id: uid(), name, joinedAt: Date.now() })
  })
  myName = name
  localStorage.setItem('cc:myName', name)
}

function removePlayer(id) {
  mutate(s => {
    s.players = s.players.filter(p => p.id !== id)
  })
}

function randomizeTeams() {
  if (state.players.length < 4) {
    toast('Need at least 4 players')
    return
  }
  mutate(s => {
    const seed = Date.now() >>> 0
    const shuffledPlayers = shuffled(s.players, seed)
    const teams = []
    for (let i = 0; i < shuffledPlayers.length; i += 2) {
      const p1 = shuffledPlayers[i]
      const p2 = shuffledPlayers[i + 1]
      if (!p2) {
        // Odd player — single-player team (effectively sits out a round with BYE)
        teams.push({ id: uid(), playerIds: [p1.id], name: `${p1.name} (solo)` })
      } else {
        const ids = [p1.id, p2.id]
        teams.push({ id: uid(), playerIds: ids, name: generateTeamName(ids) })
      }
    }
    s.teams = teams
    s.matches = buildSchedule(teams, s.courts)
    s.status = 'in_progress'
  })
  toast('Teams randomized. Godspeed.')
  showTab('matches')
}

function setScore(matchId, a, b) {
  const A = parseInt(a, 10)
  const B = parseInt(b, 10)
  const result = validateScore(A, B)
  if (!result.ok) { toast(result.reason); return }
  mutate(s => {
    const m = s.matches.find(x => x.id === matchId)
    if (!m) return
    m.scoreA = A
    m.scoreB = B
    m.done = true
    if (s.matches.every(x => x.done)) s.status = 'finished'
  })
}

function clearScore(matchId) {
  mutate(s => {
    const m = s.matches.find(x => x.id === matchId)
    if (!m) return
    m.scoreA = null
    m.scoreB = null
    m.done = false
    s.status = 'in_progress'
  })
}

function resetTournament() {
  mutate(s => {
    s.teams = null
    s.matches = []
    s.status = 'lobby'
  })
  toast('Tournament reset. Fresh carnage incoming.')
  showTab('lobby')
}

function setCourts(n) {
  n = Math.max(MIN_COURTS, Math.min(MAX_COURTS, n | 0))
  mutate(s => {
    s.courts = n
    if (s.teams && s.teams.length >= 2) {
      // Re-generate schedule with new court count, preserving any completed scores
      const oldResults = new Map()
      s.matches.forEach(m => {
        if (m.done) oldResults.set(`${m.teamAId}|${m.teamBId}`, { a: m.scoreA, b: m.scoreB })
      })
      s.matches = buildSchedule(s.teams, n)
      s.matches.forEach(m => {
        const key1 = `${m.teamAId}|${m.teamBId}`
        const key2 = `${m.teamBId}|${m.teamAId}`
        const prev = oldResults.get(key1) || oldResults.get(key2)
        if (prev) {
          // Match the original orientation
          if (oldResults.get(key1)) { m.scoreA = prev.a; m.scoreB = prev.b }
          else { m.scoreA = prev.b; m.scoreB = prev.a }
          m.done = true
        }
      })
    }
  })
}

// ---------------------------------------------------------------------------
// PIN gate
// ---------------------------------------------------------------------------

async function verifyPin(pin) {
  const hash = await sha256(pin + ':' + state.roomId + ':' + state.pinSalt)
  return hash === state.pinHash
}

function getCachedPin() {
  if (!state.roomId) return null
  return localStorage.getItem(LS_PIN(state.roomId))
}

async function requirePin(reason) {
  const cached = getCachedPin()
  if (cached && await verifyPin(cached)) return true

  return new Promise(resolve => {
    const modal = $('[data-role="pin-modal"]')
    const input = $('[data-role="pin-input"]')
    const err   = $('[data-role="pin-error"]')
    $('[data-role="pin-reason"]').textContent = reason || 'Enter the 2-digit PIN to continue.'
    err.classList.add('hidden')
    input.value = ''
    modal.classList.remove('hidden')
    setTimeout(() => input.focus(), 50)

    const close = (ok) => {
      modal.classList.add('hidden')
      $('[data-role="pin-submit"]').onclick = null
      $('[data-role="pin-cancel"]').onclick = null
      input.onkeydown = null
      resolve(ok)
    }

    const submit = async () => {
      const pin = input.value.trim()
      if (!/^\d{2}$/.test(pin)) {
        err.textContent = 'PIN must be 2 digits.'
        err.classList.remove('hidden')
        return
      }
      if (await verifyPin(pin)) {
        localStorage.setItem(LS_PIN(state.roomId), pin)
        close(true)
      } else {
        err.textContent = 'Wrong PIN.'
        err.classList.remove('hidden')
        input.value = ''
      }
    }

    $('[data-role="pin-submit"]').onclick = submit
    $('[data-role="pin-cancel"]').onclick = () => close(false)
    input.onkeydown = (e) => { if (e.key === 'Enter') submit() }
  })
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let currentTab = 'lobby'

function showView(view) {
  $$('[data-view]').forEach(el => el.classList.add('hidden'))
  const target = $(`[data-view="${view}"]`)
  if (target) target.classList.remove('hidden')
}

function showTab(tab) {
  currentTab = tab
  showView(tab)
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab))
}

function showHome() {
  $('[data-role="tabbar"]').classList.add('hidden')
  $('[data-role="share-btn"]').classList.add('hidden')
  $('[data-role="room-name"]').textContent = 'Carnage Courts'
  setConnStatus('offline', 'Home')
  renderHome()
  showView('home')
}

function showSetup({ fromHome = false } = {}) {
  $('[data-role="tabbar"]').classList.add('hidden')
  $('[data-role="share-btn"]').classList.add('hidden')
  $('[data-role="room-name"]').textContent = 'New Tournament'
  const backBtn = $('[data-role="setup-back"]')
  backBtn.classList.toggle('hidden', !fromHome)
  showView('setup')
}

function setConnStatus(kind, label) {
  const dot = $('[data-role="conn-dot"]')
  const lab = $('[data-role="conn-label"]')
  dot.classList.remove('bg-sub', 'bg-volt', 'bg-amber', 'bg-danger', 'pulse-dot')
  if (kind === 'online')     { dot.classList.add('bg-volt', 'pulse-dot') }
  else if (kind === 'connecting') { dot.classList.add('bg-amber') }
  else                        { dot.classList.add('bg-sub') }
  lab.textContent = label
}

function updatePeerCount() {
  $('[data-role="peer-count"]').textContent = `${peerCount} ${peerCount === 1 ? 'peer' : 'peers'}`
}

function render() {
  if (!state.roomId) {
    // Home/setup is handled separately via showHome()/showSetup().
    return
  }

  $('[data-role="tabbar"]').classList.remove('hidden')
  $('[data-role="share-btn"]').classList.remove('hidden')
  $('[data-role="room-name"]').textContent = state.roomId

  renderLobby()
  renderMatches()
  renderLeaderboard()

  // If we landed on setup/home but have a room now, switch to lobby
  const inRoomView = ['lobby', 'matches', 'leaderboard'].some(
    v => !$(`[data-view="${v}"]`).classList.contains('hidden')
  )
  if (!inRoomView) showTab(currentTab || 'lobby')
}

// ---------------------------------------------------------------------------
// Home view: enumerates tournaments stored on this device
// ---------------------------------------------------------------------------

function enumerateLocalRooms() {
  const rooms = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith('cc:state:')) continue
    try {
      const s = JSON.parse(localStorage.getItem(key))
      if (s?.roomId) rooms.push(s)
    } catch {}
  }
  return rooms
}

function parseISODateLocal(iso) {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function tournamentDateOf(s) {
  // Prefer explicit tournamentDate; fall back to createdAt for legacy rooms
  if (s.tournamentDate) return parseISODateLocal(s.tournamentDate)
  if (s.createdAt) return new Date(s.createdAt)
  return null
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function daysFromToday(date) {
  if (!date) return null
  const today = startOfDay(new Date())
  const d = startOfDay(date)
  return Math.round((d - today) / 86400000)
}

function formatCardDate(date) {
  if (!date) return ''
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function computeLeader(s) {
  if (!s.teams || !s.matches?.length) return null
  const done = s.matches.filter(m => m.done)
  if (!done.length) return null
  const stats = new Map(s.teams.map(t => [t.id, { team: t, wins: 0, diff: 0 }]))
  for (const m of done) {
    const a = stats.get(m.teamAId), b = stats.get(m.teamBId)
    if (!a || !b) continue
    a.diff += (m.scoreA - m.scoreB); b.diff += (m.scoreB - m.scoreA)
    if (m.scoreA > m.scoreB) a.wins++; else b.wins++
  }
  const sorted = [...stats.values()].sort((x, y) => y.wins - x.wins || y.diff - x.diff)
  return sorted[0]?.team?.name
}

function renderTournamentCard(s, { isPast }) {
  const li = document.createElement('li')
  li.className = `bg-panel border border-line rounded-2xl p-4 flex items-center gap-3 ${isPast ? 'opacity-80' : ''}`
  li.dataset.resumeRoom = s.roomId
  li.style.cursor = 'pointer'

  const players = s.players?.length || 0
  const totalMatches = s.matches?.length || 0
  const doneMatches = s.matches?.filter(m => m.done).length || 0
  const statusLabel = s.status === 'finished' ? 'Finished'
    : (s.status === 'in_progress' ? 'In progress' : 'Lobby')
  const statusColor = s.status === 'finished' ? 'text-amber'
    : (s.status === 'in_progress' ? 'text-volt' : 'text-sub')

  const signedUpNames = (s.players || []).map(p => p.name)
  const signedUpPreview = signedUpNames.slice(0, 4).join(', ') +
    (signedUpNames.length > 4 ? ` +${signedUpNames.length - 4}` : '')

  // "Played" = players who appear in at least one completed match
  const playedIds = new Set()
  for (const m of (s.matches || [])) {
    if (!m.done) continue
    const a = s.teams?.find(t => t.id === m.teamAId)
    const b = s.teams?.find(t => t.id === m.teamBId)
    for (const pid of [...(a?.playerIds || []), ...(b?.playerIds || [])]) playedIds.add(pid)
  }
  const playedCount = playedIds.size

  const leader = computeLeader(s)
  const tDate = tournamentDateOf(s)
  const dDelta = daysFromToday(tDate)
  let dateStr = formatCardDate(tDate)
  if (dDelta === 0) dateStr = 'Today'
  else if (dDelta === 1) dateStr = 'Tomorrow'
  else if (dDelta === -1) dateStr = 'Yesterday'

  const primaryActionLabel = isPast ? 'View' : (s.status === 'lobby' ? 'Sign up' : 'Play')

  li.innerHTML = `
    <div class="flex-1 min-w-0">
      <div class="flex items-baseline justify-between gap-2">
        <div class="font-display font-bold text-ink truncate">${escapeHtml(s.roomId)}</div>
        <span class="text-[10px] ${statusColor} uppercase tracking-widest shrink-0">${statusLabel}</span>
      </div>
      <div class="text-xs text-sub mt-0.5 truncate">
        ${dateStr ? escapeHtml(dateStr) + ' · ' : ''}${players} signed up${playedCount ? ` · ${playedCount} played` : ''}${totalMatches ? ` · ${doneMatches}/${totalMatches} matches` : ''}
      </div>
      ${signedUpPreview ? `<div class="text-xs text-sub mt-1 truncate">👥 ${escapeHtml(signedUpPreview)}</div>` : ''}
      ${leader ? `<div class="text-xs text-volt mt-0.5 truncate">🏆 ${escapeHtml(leader)}</div>` : ''}
    </div>
    <div class="flex flex-col gap-1 shrink-0">
      <span class="bg-volt text-bg text-xs font-bold px-3 py-2 rounded-lg text-center pointer-events-none">${primaryActionLabel}</span>
      <button type="button" data-delete-room="${escapeHtml(s.roomId)}"
              class="bg-panel2 border border-line text-sub text-xs px-3 py-2 rounded-lg active:scale-95 transition"
              aria-label="Remove from this device">🗑</button>
    </div>
  `
  return li
}

function renderHome() {
  const all = enumerateLocalRooms()

  // Split by tournament date — today or future = "Happening Now / Upcoming",
  // strictly before today = "Previous".
  const today = []
  const past  = []
  for (const s of all) {
    const delta = daysFromToday(tournamentDateOf(s))
    if (delta === null || delta >= 0) today.push(s)
    else past.push(s)
  }
  today.sort((a, b) => (daysFromToday(tournamentDateOf(a)) ?? 0) - (daysFromToday(tournamentDateOf(b)) ?? 0))
  past.sort((a, b) => (tournamentDateOf(b)?.getTime() || 0) - (tournamentDateOf(a)?.getTime() || 0))

  const todaySection = $('[data-role="home-today"]')
  const todayList = $('[data-role="home-today-list"]')
  const pastSection = $('[data-role="home-past"]')
  const pastList = $('[data-role="home-past-list"]')
  const emptySection = $('[data-role="home-empty"]')

  todayList.innerHTML = ''
  pastList.innerHTML = ''

  if (today.length) {
    todaySection.classList.remove('hidden')
    today.forEach(s => todayList.appendChild(renderTournamentCard(s, { isPast: false })))
  } else {
    todaySection.classList.add('hidden')
  }

  if (past.length) {
    pastSection.classList.remove('hidden')
    past.forEach(s => pastList.appendChild(renderTournamentCard(s, { isPast: true })))
  } else {
    pastSection.classList.add('hidden')
  }

  if (!today.length && !past.length) {
    emptySection.classList.remove('hidden')
  } else {
    emptySection.classList.add('hidden')
  }
}

function renderLobby() {
  const list = $('[data-role="player-list"]')
  const empty = $('[data-role="player-empty"]')
  list.innerHTML = ''
  if (state.players.length === 0) {
    empty.classList.remove('hidden')
  } else {
    empty.classList.add('hidden')
    state.players.forEach(p => {
      const li = document.createElement('li')
      li.className = 'flex items-center justify-between py-3'
      const isMe = p.name === myName
      li.innerHTML = `
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-8 h-8 rounded-full bg-panel2 border border-line flex items-center justify-center text-xs font-bold">
            ${escapeHtml(p.name.slice(0, 1).toUpperCase())}
          </div>
          <span class="truncate ${isMe ? 'text-volt font-semibold' : ''}">${escapeHtml(p.name)}${isMe ? ' · you' : ''}</span>
        </div>
        <button data-remove="${p.id}" class="text-sub hover:text-danger text-xl px-2" aria-label="Remove">✕</button>
      `
      list.appendChild(li)
    })
    list.onclick = async (e) => {
      const btn = e.target.closest('[data-remove]')
      if (!btn) return
      if (state.teams) {
        if (!await requirePin('Removing a player after teams are set needs the PIN.')) return
      }
      removePlayer(btn.dataset.remove)
    }
  }
  $('[data-role="player-count"]').textContent = state.players.length

  // Pre-fill the add-player input with the remembered name so the user
  // just taps Add — no retyping across tournaments.
  const nameInput = $('[data-role="add-player-name"]')
  const alreadyInRoom = myName && state.players.some(p => p.name.toLowerCase() === myName.toLowerCase())
  if (nameInput && !nameInput.value && myName && !alreadyInRoom) {
    nameInput.value = myName
  }

  // Randomize button gating
  const rand = $('[data-role="randomize-teams"]')
  const canRandomize = state.players.length >= 4
  rand.disabled = !canRandomize
  rand.textContent = state.teams ? '🎲 Re-Randomize Teams' : '🎲 Randomize Teams'

  // Teams display
  const teamsList = $('[data-role="teams-list"]')
  const teamsEmpty = $('[data-role="teams-empty"]')
  const teamsStatus = $('[data-role="teams-status"]')
  teamsList.innerHTML = ''
  if (!state.teams || state.teams.length === 0) {
    teamsEmpty.classList.remove('hidden')
    teamsStatus.textContent = 'Unformed'
  } else {
    teamsEmpty.classList.add('hidden')
    teamsStatus.textContent = `${state.teams.length} teams`
    state.teams.forEach(t => {
      const div = document.createElement('div')
      div.className = 'bg-panel2 border border-line rounded-xl p-3'
      const playerNames = t.playerIds.map(id => state.players.find(p => p.id === id)?.name || '?').join(' + ')
      div.innerHTML = `
        <div class="font-display font-bold text-ink">${escapeHtml(t.name)}</div>
        <div class="text-xs text-sub mt-0.5 truncate">${escapeHtml(playerNames)}</div>
      `
      teamsList.appendChild(div)
    })
  }

  $('[data-role="court-count"]').textContent = state.courts
}

function renderMatches() {
  const list = $('[data-role="matches-list"]')
  const empty = $('[data-role="matches-empty"]')
  list.innerHTML = ''
  if (!state.matches || state.matches.length === 0) {
    empty.classList.remove('hidden')
    return
  }
  empty.classList.add('hidden')

  // Group by round
  const byRound = new Map()
  state.matches.forEach(m => {
    if (!byRound.has(m.round)) byRound.set(m.round, [])
    byRound.get(m.round).push(m)
  })

  const teamById = new Map(state.teams.map(t => [t.id, t]))

  Array.from(byRound.entries()).sort((a, b) => a[0] - b[0]).forEach(([round, matches]) => {
    const section = document.createElement('div')
    section.className = 'space-y-2'
    const doneCount = matches.filter(m => m.done).length
    section.innerHTML = `
      <div class="flex items-baseline justify-between px-1">
        <h3 class="font-display text-lg font-bold">Round ${round}</h3>
        <span class="text-xs text-sub">${doneCount}/${matches.length} done</span>
      </div>
    `
    matches
      .slice()
      .sort((a, b) => a.wave - b.wave || a.court - b.court)
      .forEach(m => section.appendChild(renderMatchCard(m, teamById)))
    list.appendChild(section)
  })
}

function renderMatchCard(m, teamById) {
  const card = document.createElement('div')
  const A = teamById.get(m.teamAId)
  const B = teamById.get(m.teamBId)
  const aWon = m.done && m.scoreA > m.scoreB
  const bWon = m.done && m.scoreB > m.scoreA

  card.className = `bg-panel border border-line rounded-2xl p-4 ${m.done ? 'opacity-90' : ''}`
  card.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <div class="text-xs uppercase tracking-widest text-sub font-semibold">
        Court ${m.court}${m.wave > 1 ? ` · Wave ${m.wave}` : ''}
      </div>
      <div class="text-xs ${m.done ? 'text-volt' : 'text-sub'} font-semibold uppercase tracking-widest">
        ${m.done ? 'Final' : 'Pending'}
      </div>
    </div>

    <div class="grid grid-cols-[1fr_auto_1fr] gap-3 items-center">
      <div class="team-side p-3 rounded-xl border border-line ${aWon ? 'winner' : (m.done ? 'loser' : '')}">
        <div class="font-display font-bold truncate">${escapeHtml(A?.name || '?')}</div>
        <div class="text-xs text-sub mt-0.5 truncate">${escapeHtml(playerNames(A))}</div>
        <input type="number" class="score-input mt-2"
               inputmode="numeric" min="0" max="30"
               data-score="${m.id}" data-side="a"
               value="${m.scoreA ?? ''}"
               placeholder="–" />
      </div>

      <div class="text-center text-sub font-display font-bold">vs</div>

      <div class="team-side p-3 rounded-xl border border-line ${bWon ? 'winner' : (m.done ? 'loser' : '')}">
        <div class="font-display font-bold truncate text-right">${escapeHtml(B?.name || '?')}</div>
        <div class="text-xs text-sub mt-0.5 truncate text-right">${escapeHtml(playerNames(B))}</div>
        <input type="number" class="score-input mt-2"
               inputmode="numeric" min="0" max="30"
               data-score="${m.id}" data-side="b"
               value="${m.scoreB ?? ''}"
               placeholder="–" />
      </div>
    </div>

    <div class="flex gap-2 mt-3">
      <button data-role="log-score" data-match="${m.id}"
              class="flex-1 bg-danger text-ink font-bold py-3 rounded-xl active:scale-95 transition">
        ${m.done ? '↻ Update Score' : '💀 Log the Carnage'}
      </button>
      ${m.done ? `<button data-role="clear-score" data-match="${m.id}" class="bg-panel2 border border-line px-4 rounded-xl text-sub">Clear</button>` : ''}
    </div>
  `
  return card
}

function playerNames(team) {
  if (!team) return ''
  return team.playerIds.map(id => state.players.find(p => p.id === id)?.name || '?').join(' + ')
}

function renderLeaderboard() {
  const list = $('[data-role="leaderboard-list"]')
  const empty = $('[data-role="leaderboard-empty"]')
  list.innerHTML = ''
  if (!state.teams || state.matches.every(m => !m.done)) {
    empty.classList.remove('hidden')
    return
  }
  empty.classList.add('hidden')

  const standings = state.teams.map(t => ({
    team: t,
    played: 0, wins: 0, losses: 0, pf: 0, pa: 0
  }))
  const byId = new Map(standings.map(s => [s.team.id, s]))

  state.matches.forEach(m => {
    if (!m.done) return
    const a = byId.get(m.teamAId), b = byId.get(m.teamBId)
    if (!a || !b) return
    a.played++; b.played++
    a.pf += m.scoreA; a.pa += m.scoreB
    b.pf += m.scoreB; b.pa += m.scoreA
    if (m.scoreA > m.scoreB) { a.wins++; b.losses++ }
    else                     { b.wins++; a.losses++ }
  })

  standings.sort((x, y) =>
    y.wins - x.wins ||
    (y.pf - y.pa) - (x.pf - x.pa) ||
    y.pf - x.pf
  )

  standings.forEach((s, i) => {
    const rankClass = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : ''
    const li = document.createElement('li')
    li.className = `bg-panel border border-line rounded-2xl p-4 flex items-center gap-3 ${rankClass}`
    const diff = s.pf - s.pa
    const diffStr = (diff >= 0 ? '+' : '') + diff
    li.innerHTML = `
      <div class="w-10 h-10 rounded-full bg-panel2 border border-line flex items-center justify-center font-display font-bold text-lg ${i === 0 ? 'text-amber' : ''}">
        ${i + 1}
      </div>
      <div class="flex-1 min-w-0">
        <div class="font-display font-bold truncate">${escapeHtml(s.team.name)}</div>
        <div class="text-xs text-sub truncate">${escapeHtml(playerNames(s.team))}</div>
      </div>
      <div class="text-right">
        <div class="font-mono text-lg font-bold">${s.wins}<span class="text-sub text-sm font-normal">–${s.losses}</span></div>
        <div class="text-xs font-mono ${diff > 0 ? 'text-volt' : diff < 0 ? 'text-danger' : 'text-sub'}">${diffStr}</div>
      </div>
    `
    list.appendChild(li)
  })
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer
function toast(msg, ms = 2200) {
  const el = $('[data-role="toast"]')
  el.firstElementChild.textContent = msg
  el.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms)
}

// ---------------------------------------------------------------------------
// URL / room bootstrapping
// ---------------------------------------------------------------------------

function getRoomFromURL() {
  const params = new URLSearchParams(location.search)
  // Support both new short param `?r=` and legacy `?room=`
  return params.get('r') || params.get('room')
}

function setRoomInURL(roomId) {
  const url = new URL(location.href)
  url.searchParams.delete('room')
  url.searchParams.set('r', roomId)
  history.replaceState(null, '', url)
}

function clearRoomFromURL() {
  const url = new URL(location.href)
  url.searchParams.delete('r')
  url.searchParams.delete('room')
  history.replaceState(null, '', url)
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

// State for the setup screen — date + re-rollable suffix
let setupSuffix = randomSuffix()

function randomSuffix() {
  return Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 2).padEnd(2, 'x')
}

function updateRoomPreview() {
  const dateInput = $('[data-role="new-room-date"]')
  const preview = $('[data-role="new-room-preview"]')
  if (!dateInput || !preview) return
  const dateStr = dateInput.value || toDateInputValue(new Date())
  // Parse as local midnight to avoid off-by-one day from UTC
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  preview.textContent = generateRoomName(date, setupSuffix)
}

function wireSetup() {
  const dateInput = $('[data-role="new-room-date"]')
  const pinInput = $('[data-role="new-room-pin"]')
  dateInput.value = toDateInputValue(new Date())
  updateRoomPreview()

  dateInput.oninput = updateRoomPreview

  $('[data-role="roll-room-name"]').onclick = () => {
    setupSuffix = randomSuffix()
    updateRoomPreview()
  }

  $('[data-role="create-room"]').onclick = async () => {
    const roomName = $('[data-role="new-room-preview"]').textContent.trim()
    const tournamentDate = dateInput.value
    const pin = pinInput.value.trim()
    if (!roomName || roomName.length < 3) { toast('Pick a date first'); return }
    if (!/^\d{2}$/.test(pin)) { toast('PIN must be exactly 2 digits'); return }
    await createRoom({ roomName, pin, tournamentDate })
    showTab('lobby')
  }

  $('[data-role="setup-back"]').onclick = () => {
    showHome()
  }
}

function wireHome() {
  $('[data-role="home-new"]').onclick = () => {
    setupSuffix = randomSuffix()
    updateRoomPreview()
    showSetup({ fromHome: true })
  }

  $('[data-role="join-existing"]').onclick = () => {
    const entered = prompt('Enter existing room ID (e.g., sat18apr-qz):')
    if (entered) {
      setRoomInURL(entered.trim())
      location.reload()
    }
  }

  // Delegated click for resume + delete on tournament cards
  const onCardClick = (e) => {
    const del = e.target.closest('[data-delete-room]')
    if (del) {
      e.stopPropagation()
      const rid = del.dataset.deleteRoom
      if (!confirm(`Remove "${rid}" from this device? Others in the room still have it; you can rejoin via the URL.`)) return
      localStorage.removeItem(LS_STATE(rid))
      localStorage.removeItem(LS_PIN(rid))
      renderHome()
      return
    }
    const card = e.target.closest('[data-resume-room]')
    if (card) {
      const rid = card.dataset.resumeRoom
      setRoomInURL(rid)
      location.reload()
    }
  }
  $('[data-role="home-today-list"]').addEventListener('click', onCardClick)
  $('[data-role="home-past-list"]').addEventListener('click', onCardClick)
}

function wireBrand() {
  $('[data-role="brand"]').onclick = () => {
    // If in a room, go back to home. If already on home/setup, no-op.
    if (state.roomId) {
      if (roomHandle) { try { roomHandle.leave() } catch {} ; roomHandle = null }
      state = initialState()
      clearRoomFromURL()
      showHome()
    }
  }
}

function wireLobby() {
  $('[data-role="add-player-form"]').onsubmit = (e) => {
    e.preventDefault()
    const input = $('[data-role="add-player-name"]')
    const v = input.value
    if (!v.trim()) return
    addPlayer(v)
    input.value = ''
  }

  $('[data-role="randomize-teams"]').onclick = async () => {
    if (!await requirePin('Randomizing teams requires the admin PIN.')) return
    if (state.teams && !confirm('Teams already exist. Re-randomize and reset all scores?')) return
    randomizeTeams()
  }

  $('[data-role="reset-tournament"]').onclick = async () => {
    if (!await requirePin('Resetting the tournament requires the admin PIN.')) return
    if (!confirm('Reset tournament? Players and teams will be wiped.')) return
    resetTournament()
  }

  $('[data-role="change-courts"]').onclick = async () => {
    if (state.teams) {
      if (!await requirePin('Changing court count rebuilds the schedule. Needs PIN.')) return
    }
    const v = prompt(`Number of courts (${MIN_COURTS}–${MAX_COURTS}):`, state.courts)
    const n = parseInt(v, 10)
    if (Number.isFinite(n) && n >= MIN_COURTS && n <= MAX_COURTS) setCourts(n)
  }
}

function wireMatches() {
  // Score logging is open — anyone playing can log their match. PIN only
  // gates structural changes (randomize, reset, court count).
  $('[data-role="matches-list"]').addEventListener('click', (e) => {
    const logBtn = e.target.closest('[data-role="log-score"]')
    if (logBtn) {
      const id = logBtn.dataset.match
      const a = $(`[data-score="${id}"][data-side="a"]`).value
      const b = $(`[data-score="${id}"][data-side="b"]`).value
      setScore(id, a, b)
      return
    }
    const clearBtn = e.target.closest('[data-role="clear-score"]')
    if (clearBtn) {
      clearScore(clearBtn.dataset.match)
    }
  })
}

function wireTabs() {
  $$('.tab-btn').forEach(b => {
    b.onclick = () => showTab(b.dataset.tab)
  })
}

function wireShare() {
  $('[data-role="share-btn"]').onclick = async () => {
    const url = location.href
    const text = `Join my badminton tournament: ${state.roomId}`
    if (navigator.share) {
      try { await navigator.share({ title: 'Carnage Courts', text, url }); return } catch {}
    }
    try {
      await navigator.clipboard.writeText(url)
      toast('Link copied')
    } catch {
      prompt('Copy this URL:', url)
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  wireSetup()
  wireHome()
  wireLobby()
  wireMatches()
  wireTabs()
  wireShare()
  wireBrand()

  const urlRoom = getRoomFromURL()
  if (urlRoom) {
    const local = loadLocal(urlRoom)
    if (local) {
      state = local
    } else {
      // Empty shell until a peer sends us state
      state = initialState()
      state.roomId = urlRoom
    }
    // Normalise URL: upgrade legacy ?room= to ?r=
    setRoomInURL(urlRoom)
    joinTrysteroRoom(urlRoom)
    showTab('lobby')
    render()
    return
  }

  // No room in URL — show home or setup depending on whether there's history
  const existing = enumerateLocalRooms()
  if (existing.length === 0) {
    showSetup({ fromHome: false })
  } else {
    showHome()
  }
}

boot()
