// YouTube Party Sync - Main Application
// Version: 3.3.7

// --- API QUOTA OPTIMIZATION ---
// Cache last search results for Up Next (no API call needed!)
let lastSearchResults = [];
let lastSearchTime = 0;
const SEARCH_COOLDOWN = 2000; // 2 second cooldown between searches

// --- LAYOUT SYSTEM ---
const layoutToggle = document.getElementById('themeToggle');
const layoutDropdown = document.getElementById('themeDropdown');
const layoutOptions = document.querySelectorAll('.theme-option');
const cinemaSidebarToggle = document.getElementById('cinemaSidebarToggle');
const sidebar = document.querySelector('.sidebar');

// Available layouts
const LAYOUTS = {
    'classic': 'Classic - Video with sidebar',
    'cinema': 'Cinema - Immersive video focus',
    'streamline': 'Streamline - Modern grid panels'
};

// Load saved layout or default to classic
function loadLayout() {
    const savedLayout = localStorage.getItem('layout') || 'classic';
    applyLayout(savedLayout);
}

// Apply layout to document
function applyLayout(layoutName) {
    // Set data-layout attribute on html element
    document.documentElement.setAttribute('data-layout', layoutName);
    
    // Update active state in dropdown
    layoutOptions.forEach(option => {
        option.classList.toggle('active', option.dataset.layout === layoutName);
    });
    
    // Close cinema sidebar when switching layouts
    if (sidebar) {
        sidebar.classList.remove('open');
    }
    if (cinemaSidebarToggle) {
        cinemaSidebarToggle.classList.remove('active');
    }
    
    // Save to localStorage
    localStorage.setItem('layout', layoutName);
}

// Toggle dropdown visibility
layoutToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    layoutDropdown.classList.toggle('active');
});

// Handle layout selection
layoutOptions.forEach(option => {
    option.addEventListener('click', () => {
        const layoutName = option.dataset.layout;
        applyLayout(layoutName);
        layoutDropdown.classList.remove('active');
    });
});

// Cinema sidebar toggle
if (cinemaSidebarToggle && sidebar) {
    cinemaSidebarToggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        cinemaSidebarToggle.classList.toggle('active');
    });
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.theme-selector')) {
        layoutDropdown.classList.remove('active');
    }
});

// Close dropdown on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        layoutDropdown.classList.remove('active');
        // Also close cinema sidebar
        if (sidebar) sidebar.classList.remove('open');
        if (cinemaSidebarToggle) cinemaSidebarToggle.classList.remove('active');
    }
});

// Initialize layout on load
loadLayout();

// --- CONFIGURATION ---
// Firebase config - API key is safe to expose publicly
// Security is enforced by Firestore rules and Firebase Authentication
const firebaseConfig = {
    apiKey: "AIzaSyBvHqOHcW--e76fVp7exthrsapUYYcwS3Q",
    authDomain: "partysync-17cd5.firebaseapp.com",
    projectId: "partysync-17cd5",
    storageBucket: "partysync-17cd5.appspot.com",
    messagingSenderId: "294351433712",
    appId: "1:294351433712:web:826470510443b924a6b735",
    measurementId: "G-PF73SF4VGY"
};

// --- INITIALIZE FIREBASE ---
const app = firebase.initializeApp(firebaseConfig);
const db = app.firestore();

// --- DOM ELEMENTS ---
const userModal = document.getElementById('userModal');
const userNameInput = document.getElementById('userName');
const setNameBtn = document.getElementById('setNameBtn');
const nameError = document.getElementById('nameError');
const mainContent = document.getElementById('mainContent');
const searchButton = document.getElementById('searchButton');
const searchInput = document.getElementById('searchInput');
const searchSpinner = document.getElementById('searchSpinner');
const resultsList = document.getElementById('results');
const queueList = document.getElementById('queueList');
const shuffleQueueBtn = document.getElementById('shuffleQueueBtn');
const randomPlayBtn = document.getElementById('randomPlayBtn');
const hideQueueBtn = document.getElementById('hideQueueBtn');
const connectionStatus = document.getElementById('connectionStatus');
const createInviteBtn = document.getElementById('createInviteBtn');
const inviteLinkInput = document.getElementById('inviteLink');
const inviteRow = document.getElementById('inviteRow');
const copyInviteBtn = document.getElementById('copyInviteBtn');
const userList = document.getElementById('userList');
const videoTitleElement = document.getElementById('videoTitle');
const reconnectOverlay = document.getElementById('reconnectOverlay');
const reconnectMessage = document.getElementById('reconnectMessage');

// --- APP STATE ---
let myName = '';
let player;
let isHost = false;
let partyId = '';
let myAuthId = null;
let currentHostId = '';
const peerConnections = {};
const dataChannels = {};
let partyDocRef;
let videoQueue = [];
let queueHidden = false;
let randomPlayMode = false;
let lastPlayerState = -1;
let officialVideoDuration = 0;
let hostHeartbeatInterval;
let bufferingWatchdogTimeout = null;
let lastUserActionTimestamp = 0;
let intentToAutoPlay = false;
let localUserList = {};

// ICE candidate batching to reduce Firestore writes
const iceCandidateBatches = {};
const ICE_BATCH_DELAY = 100; // ms to wait before flushing candidates

// Track real user gestures to distinguish auto-pauses on hidden tabs
let lastUserGestureAt = 0;
['pointerdown', 'keydown', 'touchstart', 'click'].forEach(evt =>
    document.addEventListener(evt, () => { lastUserGestureAt = Date.now(); }, { passive: true })
);

// Track the currently loaded videoId
let currentVideoId = null;

// WebRTC configuration with STUN and free TURN servers for better connectivity
const rtcConfig = {
    iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
        // Free TURN servers from Open Relay Project (https://www.metered.ca/tools/openrelay/)
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
    iceCandidatePoolSize: 2,
};

// Helpful mapping for logging YT state numbers
const YT_STATE = {
    [-1]: 'UNSTARTED',
    [0]: 'ENDED',
    [1]: 'PLAYING',
    [2]: 'PAUSED',
    [3]: 'BUFFERING',
    [5]: 'CUED',
};

// Batch ICE candidates to reduce Firestore writes
function batchIceCandidate(collectionRef, candidate, batchKey) {
    if (!iceCandidateBatches[batchKey]) {
        iceCandidateBatches[batchKey] = { candidates: [], timeout: null, ref: collectionRef };
    }
    iceCandidateBatches[batchKey].candidates.push(candidate.toJSON());
    
    // Clear existing timeout and set a new one
    if (iceCandidateBatches[batchKey].timeout) {
        clearTimeout(iceCandidateBatches[batchKey].timeout);
    }
    
    iceCandidateBatches[batchKey].timeout = setTimeout(async () => {
        const batch = iceCandidateBatches[batchKey];
        const candidates = batch.candidates;
        iceCandidateBatches[batchKey] = null;
        
        if (candidates.length === 0) return;
        
        try {
            // Use Firestore batch write for multiple candidates
            const firestoreBatch = db.batch();
            candidates.forEach(cand => {
                const docRef = batch.ref.doc();
                firestoreBatch.set(docRef, cand);
            });
            await firestoreBatch.commit();
            console.log(`[ICE] Batched ${candidates.length} candidates to Firestore`);
        } catch (e) {
            console.error('[ICE] Failed to batch write candidates:', e);
        }
    }, ICE_BATCH_DELAY);
}

// Up Next overlay elements
const upNextOverlay = document.getElementById('upNextOverlay');
const upNextList = document.getElementById('upNextList');
const upNextCloseBtn = document.getElementById('upNextCloseBtn');
const upNextReplayBtn = document.getElementById('upNextReplayBtn');
let upNextActive = false;

// Also grab the container to toggle a helper class
const playerContainer = document.querySelector('.player-container');

// --- UP NEXT OVERLAY FUNCTIONS ---
function showUpNextOverlay() {
    // Move overlay to be last child to sit above everything
    if (upNextOverlay.parentElement) {
        upNextOverlay.parentElement.appendChild(upNextOverlay);
    }
    upNextOverlay.classList.add('active');
    upNextOverlay.setAttribute('aria-hidden', 'false');
    // Inline fallbacks in case of CSS specificity issues
    upNextOverlay.style.opacity = '1';
    upNextOverlay.style.pointerEvents = 'auto';
    if (playerContainer) playerContainer.classList.add('overlay-active');
    upNextActive = true;
}

function hideUpNextOverlay() {
    upNextOverlay.classList.remove('active');
    upNextOverlay.setAttribute('aria-hidden', 'true');
    upNextOverlay.style.opacity = '';
    upNextOverlay.style.pointerEvents = '';
    if (playerContainer) playerContainer.classList.remove('overlay-active');
    upNextActive = false;
}

function populateUpNextSuggestions() {
    // Use last search results instead of making API call - saves 100 quota units!
    const vid = currentVideoId;
    
    // Filter out the current video from suggestions
    const suggestions = lastSearchResults.filter(v => v.videoId && v.videoId !== vid).slice(0, 8);
    
    if (suggestions.length === 0) {
        upNextList.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;opacity:.8;">
                <p>No suggestions available.</p>
                <p style="font-size:0.9em;margin-top:8px;">Search for videos to see suggestions here.</p>
            </div>`;
        return;
    }
    
    renderUpNextItems(suggestions, vid);
}

// Render Up Next items from cached search results
function renderUpNextItems(items, currentVid) {
    upNextList.innerHTML = '';
    for (const it of items) {
        if (it.videoId === currentVid) continue; // Skip current video
        const card = document.createElement('div');
        card.className = 'upnext-item';
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `Play ${it.title}`);
        card.innerHTML = `
            <img class="upnext-thumb" src="${it.thumb}" alt="">
            <div class="upnext-info">
                <div class="upnext-title-line" title="${it.title}">${it.title}</div>
                <div class="upnext-meta" title="${it.channel}">${it.channel}</div>
            </div>
        `;
        const playSelected = () => {
            hideUpNextOverlay();
            handleUserAction({ type: 'NEW_VIDEO', videoId: it.videoId, autoPlay: true });
        };
        card.addEventListener('click', playSelected);
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                playSelected();
            }
        });
        upNextList.appendChild(card);
    }
}

upNextCloseBtn.addEventListener('click', hideUpNextOverlay);
upNextReplayBtn.addEventListener('click', () => {
    if (currentVideoId) {
        hideUpNextOverlay();
        handleUserAction({ type: 'NEW_VIDEO', videoId: currentVideoId, autoPlay: true });
    }
});

// Intercept YouTube suggestion clicks that try to open a new tab and play them in-app instead
(function installYouTubeOpenInterceptor() {
    const originalOpen = window.open ? window.open.bind(window) : null;
    function extractYouTubeVideoId(urlLike) {
        try {
            const urlStr = String(urlLike);
            const re = /(?:v=|\/shorts\/|youtu\.be\/)([A-Za-z0-9_-]{11})/;
            const m = urlStr.match(re);
            if (m && m[1]) return m[1];
            const u = new URL(urlStr, window.location.href);
            const host = u.hostname.replace(/^www\./, '');
            if (host.endsWith('youtu.be')) {
                const parts = u.pathname.split('/').filter(Boolean);
                if (parts[0] && parts[0].length === 11) return parts[0];
            }
            if (host.endsWith('youtube.com')) {
                if (u.pathname.startsWith('/shorts/')) {
                    const id = u.pathname.split('/')[2] || u.pathname.split('/')[1];
                    if (id && id.length === 11) return id;
                }
                const v = u.searchParams.get('v');
                if (v && v.length === 11) return v;
            }
        } catch (_) { /* ignore parsing errors */ }
        return null;
    }
    window.open = function (url, target, features) {
        const vid = extractYouTubeVideoId(url);
        if (vid) {
            try {
                handleUserAction({ type: 'NEW_VIDEO', videoId: vid, autoPlay: true });
                return null;
            } catch (e) {
                return originalOpen ? originalOpen(url, target, features) : null;
            }
        }
        return originalOpen ? originalOpen(url, target, features) : null;
    };
})();

// --- NAME VALIDATION ---
function validateName(name) {
    const trimmed = name.trim();
    return trimmed.length >= 2 && trimmed.length <= 30;
}

userNameInput.addEventListener('input', () => {
    const name = userNameInput.value.trim();
    const valid = validateName(name);
    if (nameError) {
        nameError.classList.toggle('hidden', valid || name.length === 0);
    }
    setNameBtn.disabled = !valid || !myAuthId;
});

// --- AUTHENTICATION & APP START ---
firebase.auth().onAuthStateChanged(user => {
    if (user) {
        myAuthId = user.uid;
        console.log("User signed in with UID:", myAuthId);
        // Re-check name validation
        const name = userNameInput.value.trim();
        setNameBtn.disabled = !validateName(name);
    } else {
        myAuthId = null;
        setNameBtn.disabled = true;
    }
});

setNameBtn.disabled = true;
firebase.auth().signInAnonymously().catch((error) => {
    console.error("Anonymous sign-in failed:", error);
    alert("Could not connect to the service. Please refresh the page.");
});

// --- INITIALIZATION ---
setNameBtn.addEventListener('click', () => {
    const name = userNameInput.value.trim();
    if (validateName(name) && myAuthId) {
        myName = name;
        userModal.classList.add('hidden');
        mainContent.classList.remove('hidden');
        initApp();
    } else if (!validateName(name)) {
        if (nameError) nameError.classList.remove('hidden');
    } else {
        alert('Could not verify connection. Please refresh the page.');
    }
});

// Allow Enter key in name input
userNameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !setNameBtn.disabled) {
        setNameBtn.click();
    }
});

function initApp() {
    const urlParams = new URLSearchParams(window.location.search);
    partyId = urlParams.get('party');
    if (partyId) {
        isHost = false;
        createInviteBtn.classList.add('hidden');
        // Detect if you opened the guest link as the same signed-in user as the host
        (async () => {
            try {
                const partySnap = await db.collection('parties').doc(partyId).get();
                const hostIdFromDoc = partySnap.data()?.hostId;
                if (hostIdFromDoc && hostIdFromDoc === myAuthId) {
                    console.warn('[JOIN] Same UID as host. Use a different browser profile/incognito for the guest.');
                    alert('You are joining with the same account as the host. Open the invite in a different browser or an incognito window so the guest has a different UID.');
                }
            } catch (e) {
                console.warn('Could not verify hostId before joining:', e);
            } finally {
                joinParty();
            }
        })();
    } else {
        isHost = true;
        document.body.classList.add('is-host');
        startHostHeartbeat();
    }
    window.addEventListener('beforeunload', () => {
        const data = { type: 'USER_LEAVING' };
        Object.values(dataChannels).forEach(channel => {
            if (channel && channel.readyState === 'open') {
                channel.send(JSON.stringify(data));
            }
        });
    });
}

// --- THEATER MODE ---
const theaterModeBtn = document.getElementById('theaterModeBtn');
const theaterCloseBtn = document.getElementById('theaterCloseBtn');
const theaterHoverSensor = document.getElementById('theaterHoverSensor');
let theaterUiHideTimer;

function showTheaterUiTemporarily(delayMs = 3000) {
    document.body.classList.add('theater-ui-visible');
    clearTimeout(theaterUiHideTimer);
    theaterUiHideTimer = setTimeout(() => {
        document.body.classList.remove('theater-ui-visible');
    }, delayMs);
}

function theaterActivityPing() {
    if (!document.body.classList.contains('theater-mode')) return;
    showTheaterUiTemporarily();
}

function disableTheaterUi() {
    clearTimeout(theaterUiHideTimer);
    document.body.classList.remove('theater-ui-visible');
    document.removeEventListener('mousemove', theaterActivityPing);
    document.removeEventListener('keydown', theaterActivityPing);
    document.removeEventListener('wheel', theaterActivityPing, { passive: true });
    document.removeEventListener('touchstart', theaterActivityPing, { passive: true });
    theaterHoverSensor.removeEventListener('mousemove', theaterActivityPing);
    theaterHoverSensor.removeEventListener('mouseenter', theaterActivityPing);
    theaterCloseBtn.removeEventListener('click', exitTheaterMode);
}

function enableTheaterUi() {
    showTheaterUiTemporarily();
    // Re-show on user activity (mouse over doc, top sensor, keys, wheel, touch)
    document.addEventListener('mousemove', theaterActivityPing);
    document.addEventListener('keydown', theaterActivityPing);
    document.addEventListener('wheel', theaterActivityPing, { passive: true });
    document.addEventListener('touchstart', theaterActivityPing, { passive: true });
    theaterHoverSensor.addEventListener('mousemove', theaterActivityPing);
    theaterHoverSensor.addEventListener('mouseenter', theaterActivityPing);
    theaterCloseBtn.addEventListener('click', exitTheaterMode);
}

function exitTheaterMode() {
    document.body.classList.remove('theater-mode');
    theaterModeBtn.title = 'Theater Mode';
    disableTheaterUi();
}

theaterModeBtn.addEventListener('click', () => {
    document.body.classList.toggle('theater-mode');
    const inTheaterMode = document.body.classList.contains('theater-mode');
    theaterModeBtn.title = inTheaterMode ? 'Exit Theater Mode' : 'Theater Mode';
    if (inTheaterMode) {
        enableTheaterUi();
    } else {
        disableTheaterUi();
    }
});

// Allow Esc to exit theater mode
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('theater-mode')) {
        exitTheaterMode();
    }
});

// --- YOUTUBE API ---
function onPlayerError(event) {
    const errorCodes = {
        2: 'Invalid video ID',
        5: 'HTML5 player error',
        100: 'Video not found (removed or private)',
        101: 'Video cannot be embedded',
        150: 'Video cannot be embedded'
    };
    const errorMessage = errorCodes[event.data] || `Unknown error code: ${event.data}`;
    console.error('[YouTube Error]', errorMessage);
    
    // Auto-skip to next video in queue if this one can't play
    if (isHost && videoQueue.length > 0) {
        console.log('[YouTube Error] Skipping to next video in queue...');
        const nextVideo = videoQueue.shift();
        broadcastData({ type: 'NEW_VIDEO', videoId: nextVideo.videoId, autoPlay: true });
        broadcastData({ type: 'QUEUE_UPDATE', queue: videoQueue });
        // Show brief notification
        showSkipNotification(errorMessage);
    } else if (isHost && videoQueue.length === 0) {
        // No more videos, show up next overlay
        console.log('[YouTube Error] No videos in queue, showing suggestions');
        showUpNextOverlay();
    }
}

// Show a brief notification when a video is skipped
function showSkipNotification(reason) {
    const notification = document.createElement('div');
    notification.className = 'skip-notification';
    notification.innerHTML = `<span>⚠️ Video skipped: ${reason}</span>`;
    document.body.appendChild(notification);
    
    // Animate in
    requestAnimationFrame(() => notification.classList.add('visible'));
    
    // Remove after 3 seconds
    setTimeout(() => {
        notification.classList.remove('visible');
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

let playerReady = false;

window.onYouTubeIframeAPIReady = () => {
    console.log('[YT] YouTube IFrame API ready, creating player...');
    player = new YT.Player('player', {
        // Don't load a video initially - wait for user to search/select
        playerVars: {
            rel: 0,
            playsinline: 1,
            modestbranding: 1,
            origin: window.location.origin
        },
        events: {
            'onReady': () => { 
                playerReady = true; 
                console.log('[YT] Player ready!');
            },
            'onStateChange': onPlayerStateChange,
            'onError': onPlayerError
        }
    });
};

searchButton.addEventListener('click', searchYouTube);
searchInput.addEventListener('keypress', e => e.key === 'Enter' && searchYouTube());

async function searchYouTube() {
    const query = searchInput.value.trim();
    if (!query) return;

    // Debounce: prevent rapid successive searches
    const now = Date.now();
    if (now - lastSearchTime < SEARCH_COOLDOWN) {
        console.log('Search cooldown active, please wait...');
        return;
    }
    lastSearchTime = now;

    // Show loading spinner
    if (searchSpinner) searchSpinner.classList.remove('hidden');
    resultsList.innerHTML = '<li>Searching...</li>';

    // This regular expression checks for various YouTube URL formats and extracts the video ID.
    const youtubeUrlRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/;
    const match = query.match(youtubeUrlRegex);

    let payload = {};
    if (match) {
        // If it's a URL, the payload will contain the video ID.
        const videoId = match[1];
        payload = { videoId: videoId };
        console.log("YouTube URL detected. Fetching by video ID:", videoId);
    } else {
        // Otherwise, it's a regular search query - search for both videos and playlists.
        payload = { query: query, searchType: 'video,playlist' };
        console.log("Performing keyword search for:", query);
    }

    const searchYoutubeFunction = app.functions('us-central1').httpsCallable('searchYoutube');
    try {
        const result = await searchYoutubeFunction(payload);
        displayResults(result.data.items || []);
    } catch (error) {
        console.error("Error calling Cloud Function:", error);
        resultsList.innerHTML = '<li>Search failed. Please try again.</li>';
    } finally {
        // Hide loading spinner
        if (searchSpinner) searchSpinner.classList.add('hidden');
    }
}

function displayResults(items) {
    // Cache video results for Up Next (filter out playlists)
    const videoItems = items.filter(item => {
        const isPlaylist = item.kind === 'youtube#playlist' || (item.id && item.id.kind === 'youtube#playlist');
        return !isPlaylist;
    }).map(item => {
        const videoId = (typeof item.id === 'object') ? item.id.videoId : item.id;
        return {
            videoId: videoId,
            title: item.snippet?.title || '',
            channel: item.snippet?.channelTitle || '',
            thumb: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url
        };
    });
    if (videoItems.length > 0) {
        lastSearchResults = videoItems;
    }
    
    resultsList.innerHTML = items.length ? '' : '<li>No results found.</li>';
    items.forEach(item => {
        // Determine if this is a video or playlist
        const isPlaylist = item.kind === 'youtube#playlist' || (item.id && item.id.kind === 'youtube#playlist');
        
        // Extract IDs based on type
        let videoId = null;
        let playlistId = null;
        
        if (isPlaylist) {
            playlistId = item.id?.playlistId || item.id;
        } else {
            videoId = (typeof item.id === 'object') ? item.id.videoId : item.id;
        }

        const title = item.snippet.title;
        const thumbnailUrl = item.snippet.thumbnails?.default?.url || item.snippet.thumbnails?.medium?.url;
        const itemCount = item.contentDetails?.itemCount;

        const li = document.createElement('li');
        li.classList.add(isPlaylist ? 'playlist-item' : 'video-item');
        
        if (isPlaylist) {
            li.dataset.playlistId = playlistId;
            li.innerHTML = `
                <div class="result-thumbnail">
                    <img src="${thumbnailUrl}" alt="${title}">
                    <span class="playlist-badge">📋 ${itemCount || ''} videos</span>
                </div>
                <div class="video-info">
                    <div class="video-title" title="Load Playlist">${title}</div>
                    <button class="queue-btn">Add All</button>
                </div>`;
        } else {
            li.dataset.videoId = videoId;
            li.innerHTML = `
                <div class="result-thumbnail">
                    <img src="${thumbnailUrl}" alt="${title}">
                </div>
                <div class="video-info">
                    <div class="video-title" title="Play Now">${title}</div>
                    <button class="queue-btn">Add</button>
                </div>`;
        }

        const clickableElements = [li.querySelector('img'), li.querySelector('.video-title')];
        clickableElements.forEach(el => el.addEventListener('click', async () => {
            if (isPlaylist && playlistId) {
                // Load playlist and add all videos to queue
                await loadPlaylistVideos(playlistId, true);
            } else if (videoId) {
                handleUserAction({ type: 'NEW_VIDEO', videoId: videoId, autoPlay: true });
            }
        }));

        li.querySelector('.queue-btn').addEventListener('click', async (e) => {
            e.stopPropagation();
            if (isPlaylist && playlistId) {
                // Add all playlist videos to queue
                await loadPlaylistVideos(playlistId, false);
            } else if (videoId) {
                const videoData = { videoId, title, thumbnailUrl };
                handleUserAction({ type: 'ADD_TO_QUEUE', video: videoData });
            }
        });

        resultsList.appendChild(li);
    });
}

// Load playlist videos from YouTube API
async function loadPlaylistVideos(playlistId, playFirst = false) {
    try {
        resultsList.innerHTML = '<li>Loading playlist...</li>';
        const searchYoutubeFunction = app.functions('us-central1').httpsCallable('searchYoutube');
        const result = await searchYoutubeFunction({ playlistId: playlistId });
        
        if (result.data.items && result.data.items.length > 0) {
            const videos = result.data.items.map(item => ({
                videoId: item.contentDetails?.videoId || item.snippet?.resourceId?.videoId,
                title: item.snippet.title,
                thumbnailUrl: item.snippet.thumbnails?.default?.url || item.snippet.thumbnails?.medium?.url
            })).filter(v => v.videoId); // Filter out deleted videos
            
            if (playFirst && videos.length > 0) {
                // Play first video immediately
                handleUserAction({ type: 'NEW_VIDEO', videoId: videos[0].videoId, autoPlay: true });
                // Add rest to queue
                videos.slice(1).forEach(video => {
                    handleUserAction({ type: 'ADD_TO_QUEUE', video: video });
                });
            } else {
                // Add all to queue
                videos.forEach(video => {
                    handleUserAction({ type: 'ADD_TO_QUEUE', video: video });
                });
            }
            
            resultsList.innerHTML = `<li style="color: var(--accent);">✓ Added ${videos.length} videos from playlist</li>`;
            // Removed auto-refresh to save API quota
        } else {
            resultsList.innerHTML = '<li>Playlist is empty or unavailable.</li>';
        }
    } catch (error) {
        console.error("Error loading playlist:", error);
        resultsList.innerHTML = '<li>Failed to load playlist.</li>';
    }
}

// --- WEBRTC & FIREBASE SIGNALING ---
createInviteBtn.addEventListener('click', async () => {
    if (!myAuthId) return alert("Cannot create party, not connected.");
    isHost = true;
    document.body.classList.add('is-host');
    partyId = crypto.randomUUID();
    currentHostId = myAuthId;
    const url = `${window.location.href.split('?')[0]}?party=${partyId}`;
    inviteLinkInput.value = url;
    // Show inline row with copy button
    inviteRow.classList.remove('hidden');
    copyInviteBtn.disabled = false;
    copyInviteBtn.textContent = 'Copy';

    createInviteBtn.disabled = true;
    partyDocRef = db.collection('parties').doc(partyId);
    try {
        await partyDocRef.set({
            hostId: myAuthId,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        console.log('[HOST] Created party doc', partyId);
    } catch (e) {
        console.error('[HOST] Failed to create party doc:', e);
        alert('Could not create party in Firestore. Check Firestore rules and console.');
        return;
    }
    listenForGuests();
    startHostHeartbeat();
});

async function joinParty() {
    if (!myAuthId) return alert("Cannot join party, not connected.");
    partyDocRef = db.collection('parties').doc(partyId);
    const guestDocRef = partyDocRef.collection('guests').doc(myAuthId);
    console.log('[JOIN] Starting joinParty for', myAuthId, 'party:', partyId);

    const pc = createPeerConnection('host');
    const candidateBuffer = [];
    pc._answerApplied = false; // prevent duplicate setRemoteDescription

    // Keep refs on the pc for ICE restarts
    pc._guestDocRef = guestDocRef;
    pc._guestGuestCandidatesRef = guestDocRef.collection('guestCandidates');
    pc._guestHostCandidatesRef = guestDocRef.collection('hostCandidates');

    dataChannels['host'] = pc.createDataChannel('sync-channel');
    console.log('[JOIN] Created data channel to host');
    configureDataChannel('host', dataChannels['host']);
    
    // Connection timeout - show warning if not connected after 15 seconds
    const connectionTimeout = setTimeout(() => {
        if (!dataChannels['host'] || dataChannels['host'].readyState !== 'open') {
            console.warn('[JOIN] Connection timeout - data channel not open after 15 seconds');
            alert('Connection is taking longer than expected. This could be due to:\n\n• Ad blocker blocking connection (try disabling uBlock Origin for this site)\n• Firewall/NAT restrictions\n• Host may have left the party\n\nPlease try refreshing the page or ask the host to create a new party.');
        }
    }, 15000);
    
    // Clear timeout when channel opens
    const originalOnOpen = dataChannels['host'].onopen;
    dataChannels['host'].addEventListener('open', () => clearTimeout(connectionTimeout));

    const guestCandidatesRef = pc._guestGuestCandidatesRef;

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            batchIceCandidate(guestCandidatesRef, event.candidate, 'guest-candidates');
        } else {
            console.log('[JOIN] ICE gathering complete');
        }
    };

    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log('[JOIN] Created offer');
        await guestDocRef.set({ offer, name: myName });
        console.log('[JOIN] Wrote offer to Firestore');
    } catch (e) {
        console.error('[JOIN] Failed to create/send offer:', e);
        alert('Could not join the party (offer failed). Check console for details.');
        return;
    }

    guestDocRef.onSnapshot(async (snapshot) => {
        const data = snapshot.data();
        if (!data || !data.answer) return;
        // Apply the host's answer only once and only in have-local-offer state
        if (pc._answerApplied) return; // Already applied, skip
        if (pc.signalingState !== 'have-local-offer') return; // Wrong state, skip silently
        
        // Set flag immediately to prevent race conditions with rapid snapshot fires
        pc._answerApplied = true;
        
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            console.log('[JOIN] Set remote description (answer) from host');
            candidateBuffer.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(err => console.error('[JOIN] addIceCandidate (buffer) failed:', err)));
            candidateBuffer.length = 0;
        } catch (e) {
            console.error('[JOIN] Failed to set remote description:', e);
            pc._answerApplied = false; // Reset on failure so it can retry
        }
    });

    pc._guestHostCandidatesRef.onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
            if (change.type === 'added') {
                const candidate = change.doc.data();
                if (pc.currentRemoteDescription) {
                    pc.addIceCandidate(new RTCIceCandidate(candidate))
                        .catch(err => console.error('[JOIN] addIceCandidate failed:', err));
                } else {
                    candidateBuffer.push(candidate);
                }
            }
        });
    });
}

function listenForGuests() {
    console.log('[HOST] Listening for guests on party', partyId);
    partyDocRef.collection('guests').onSnapshot(async snapshot => {
        for (const change of snapshot.docChanges()) {
            const doc = change.doc;
            const guestId = doc.id;
            const data = doc.data() || {};
            if (change.type === 'added') {
                const { offer, name } = data;
                console.log('[HOST] Guest added:', guestId, 'name:', name);
                // If someone joins with same UID as the host, refuse (they share auth state)
                if (guestId === myAuthId) {
                    console.warn('[HOST] Ignoring guest with same UID as host. Use a different browser/incognito for guests.');
                    continue;
                }
                if (peerConnections[guestId]) continue;

                try {
                    const guestDocRef = doc.ref;
                    const pc = createPeerConnection(guestId, name);
                    pc._hostGuestDocRef = guestDocRef;

                    pc.ondatachannel = event => {
                        console.log('[HOST] Data channel from guest', guestId);
                        dataChannels[guestId] = event.channel;
                        configureDataChannel(guestId, event.channel, name);
                    };

                    pc.onicecandidate = (event) => {
                        if (event.candidate) {
                            batchIceCandidate(guestDocRef.collection('hostCandidates'), event.candidate, `host-candidates-${guestId}`);
                        }
                    };

                    await pc.setRemoteDescription(new RTCSessionDescription(offer));
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    await guestDocRef.update({ answer });

                    guestDocRef.collection('guestCandidates').onSnapshot(snap => {
                        snap.docChanges().forEach(ch => {
                            if (ch.type === 'added') {
                                const cand = ch.doc.data();
                                pc.addIceCandidate(new RTCIceCandidate(cand))
                                    .catch(err => console.error('[HOST] addIceCandidate failed:', err));
                            }
                        });
                    });
                } catch (e) {
                    console.error('[HOST] Error handling new guest', guestId, e);
                }
            } else if (change.type === 'modified') {
                // Handle ICE-restart offers from guest
                try {
                    const pc = peerConnections[guestId];
                    if (!pc) continue;
                    if (data.offer && pc.signalingState !== 'have-remote-offer') {
                        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
                        const answer = await pc.createAnswer();
                        await pc.setLocalDescription(answer);
                        await doc.ref.update({ answer });
                    }
                } catch (e) {
                    console.error('[HOST] Failed to process modified guest doc:', guestId, e);
                }
            }
        }
    });
}

function createPeerConnection(peerId, peerName) {
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections[peerId] = pc;
    pc.peerName = peerName;
    pc.peerId = peerId;

    let disconnectTimer = null;

    pc.onconnectionstatechange = () => {
        updateConnectionStatus();
        if (pc.connectionState === 'failed') {
            console.warn(`[RTC:${peerId}] DTLS failed. Attempting ICE restart.`);
            attemptGuestIceRestart(pc);
        }
        if (peerId === 'host' && !isHost) {
            const state = pc.connectionState;
            if (state === 'disconnected' || state === 'failed' || state === 'closed') {
                console.warn(`Connection to host lost. State: ${state}`);
                if (!window.migrationInProgress && state !== 'disconnected') {
                    window.migrationInProgress = true;
                    handleHostDisconnection();
                }
            }
        }
    };
    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'disconnected') {
            clearTimeout(disconnectTimer);
            disconnectTimer = setTimeout(() => {
                if (pc.iceConnectionState === 'disconnected') {
                    attemptGuestIceRestart(pc);
                }
            }, 2000);
        } else if (pc.iceConnectionState === 'failed') {
            console.warn(`[RTC:${peerId}] ICE failed. You may need a TURN server.`);
        } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            clearTimeout(disconnectTimer);
            resetIceRestartCounter(); // Reset counter on successful connection
        }
    };
    // Remove verbose signaling state logging - only log on errors
    pc.onsignalingstatechange = () => {};
    pc.onicegatheringstatechange = () => {};
    return pc;
}

// Guest-side ICE restart helper with rate limiting
let iceRestartCount = 0;
let lastIceRestartTime = 0;
const ICE_RESTART_COOLDOWN = 10000; // 10 seconds between restarts
const ICE_RESTART_MAX = 5; // Max 5 restarts before giving up

async function attemptGuestIceRestart(pc) {
    // Only guests restart toward the host
    if (isHost || pc.peerId !== 'host') return;
    if (!pc._guestDocRef) return;
    if (pc._iceRestartInProgress) {
        return;
    }
    if (pc.signalingState === 'closed') {
        return;
    }
    
    // Rate limiting
    const now = Date.now();
    if (now - lastIceRestartTime < ICE_RESTART_COOLDOWN) {
        return;
    }
    if (iceRestartCount >= ICE_RESTART_MAX) {
        console.warn('[JOIN] ICE restart limit reached. Connection may be unstable.');
        return;
    }
    
    pc._iceRestartInProgress = true;
    lastIceRestartTime = now;
    iceRestartCount++;
    
    try {
        console.log('[JOIN] Attempting ICE restart...', iceRestartCount, '/', ICE_RESTART_MAX);
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        await pc._guestDocRef.update({
            offer,
            restartedAt: Date.now(),
            answer: firebase.firestore.FieldValue.delete()
        });
    } catch (e) {
        console.error('[JOIN] ICE restart failed:', e);
    } finally {
        pc._iceRestartInProgress = false;
    }
}

// Reset ICE restart counter when connection is successful
function resetIceRestartCounter() {
    iceRestartCount = 0;
}

// Utility: delete all docs in a subcollection (candidates)
async function clearCollection(colRef) {
    try {
        const snap = await colRef.get();
        if (snap.empty) return;
        const batch = db.batch();
        snap.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
    } catch (e) {
        console.warn('clearCollection failed:', e);
    }
}

function resetPartyState() {
    console.log("Resetting party state...");
    for (const peerId in peerConnections) {
        if (peerConnections[peerId]) {
            peerConnections[peerId].close();
        }
    }
    Object.keys(peerConnections).forEach(key => delete peerConnections[key]);
    Object.keys(dataChannels).forEach(key => delete dataChannels[key]);
    userList.innerHTML = '';
    localUserList = {};
    window.migrationInProgress = false;
}

const userColors = ['#ff7675', '#74b9ff', '#55efc4', '#ffeaa7', '#a29bfe', '#fd79a8', '#00cec9', '#fab1a0'];
const getUserColor = (userName) => {
    let hash = 0;
    for (let i = 0; i < userName.length; i++) {
        hash = userName.charCodeAt(i) + ((hash << 5) - hash);
    }
    return userColors[Math.abs(hash % userColors.length)];
};

function handleUserAction(data) {
    if (isHost) {
        // Never broadcast ENDED state - host handles video ending/queue progression separately
        if (data.type === 'STATE_CHANGE' && data.state === YT.PlayerState.ENDED) {
            return;
        }
        broadcastData(data);
    } else {
        sendRequestToHost(data);
    }
}

function sendRequestToHost(data) {
    if (isHost) return;

    if (data.type === 'STATE_CHANGE') {
        // Never forward ENDED state to host - only the host handles video ending/queue progression
        if (data.state === YT.PlayerState.ENDED) {
            return;
        }
        
        // Do not forward pauses caused by hidden tab (not user initiated)
        if (data.state === YT.PlayerState.PAUSED &&
            document.hidden && !data.userInitiated) {
            return;
        }

        // Keep ad/buffer suppression for non-pause states
        if (data.state !== YT.PlayerState.PAUSED) {
            if (officialVideoDuration > 0) {
                const currentDuration = typeof player.getDuration === 'function' ? player.getDuration() : 0;
                if (currentDuration === 0 || Math.abs(currentDuration - officialVideoDuration) > 2) {
                    return;
                }
            }
        }
    }

    const requestData = { ...data, type: `REQUEST_${data.type}` };
    const hostChannel = dataChannels['host'];
    if (hostChannel && hostChannel.readyState === 'open') {
        hostChannel.send(JSON.stringify(requestData));
    } else {
        console.warn("Host channel not open; cannot send request.");
    }
}

function broadcastData(data) {
    handleReceivedData(data, 'local');
    Object.entries(dataChannels).forEach(([id, channel]) => {
        if (id !== 'host' && channel && channel.readyState === 'open') {
            channel.send(JSON.stringify(data));
        }
    });
}

function configureDataChannel(peerId, channel, peerName = '') {
    channel.onopen = () => {
        console.log(`[DC:${peerId}] open`);
        window.migrationInProgress = false;
        // Hide reconnection overlay if shown
        if (reconnectOverlay) reconnectOverlay.classList.add('hidden');
        updateConnectionStatus();
        if (isHost) {
            const users = { [myAuthId]: { name: myName } };
            Object.entries(peerConnections).forEach(([id, pc]) => {
                if (pc.peerName) users[id] = { name: pc.peerName };
            });
            broadcastData({ type: 'USER_LIST', users });
            channel.send(JSON.stringify({ type: 'HOST_INFO', hostId: myAuthId }));
            
            // Send queue visibility state to new guest
            channel.send(JSON.stringify({ type: 'QUEUE_VISIBILITY', hidden: queueHidden }));
            
            // Send random play mode state to new guest
            channel.send(JSON.stringify({ type: 'RANDOM_PLAY_MODE', enabled: randomPlayMode }));
            
            // Get the current video ID - try player first, fall back to currentVideoId
            const playerVideoId = player?.getVideoData?.()?.video_id;
            const videoId = playerVideoId || currentVideoId;
            const playerState = player?.getPlayerState?.() ?? -1;
            
            if (videoId && playerState !== YT.PlayerState.UNSTARTED) {
                const syncData = { 
                    type: 'INITIAL_SYNC', 
                    videoId: videoId, 
                    time: player?.getCurrentTime?.() || 0, 
                    state: playerState, 
                    duration: player?.getDuration?.() || 0, 
                    queue: videoQueue 
                };
                channel.send(JSON.stringify(syncData));
            } else {
                broadcastData({ type: 'QUEUE_UPDATE', queue: videoQueue });
            }
        }
    };
    channel.onclose = () => {
        console.log(`[DC:${peerId}] close`);
        if (peerId === 'host' && !isHost && !window.migrationInProgress) {
            window.migrationInProgress = true;
            handleHostDisconnection();
            return;
        }
        if (isHost && partyDocRef) {
            partyDocRef.collection('guests').doc(peerId).delete().catch(error => console.error("Error removing guest document:", error));
        }
        delete peerConnections[peerId];
        delete dataChannels[peerId];
        updateConnectionStatus();
        if (isHost) {
            const users = { [myAuthId]: { name: myName } };
            Object.entries(peerConnections).forEach(([id, pc]) => {
                if (pc.peerName) users[id] = { name: pc.peerName };
            });
            broadcastData({ type: 'USER_LIST', users });
        }
    };
    channel.onmessage = event => {
        try { handleReceivedData(JSON.parse(event.data), peerId); }
        catch (e) { console.error(`[DC:${peerId}] bad message`, e, event.data); }
    };
}

function onPlayerStateChange(event) {
    const state = event.data;

    // Handle video ended - play next in queue or show suggestions
    if (state === YT.PlayerState.ENDED) {
        if (isHost && videoQueue.length > 0) {
            // If random play mode, shuffle queue before picking next video
            if (randomPlayMode && videoQueue.length > 1) {
                for (let i = videoQueue.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [videoQueue[i], videoQueue[j]] = [videoQueue[j], videoQueue[i]];
                }
            }
            const nextVideo = videoQueue.shift();
            hideUpNextOverlay();
            // Directly load the video for host
            currentVideoId = nextVideo.videoId;
            intentToAutoPlay = true;
            player.loadVideoById(nextVideo.videoId);
            startBufferingWatchdog(); // Start watchdog in case video gets stuck
            // Broadcast to guests
            Object.entries(dataChannels).forEach(([id, channel]) => {
                if (id !== 'host' && channel && channel.readyState === 'open') {
                    channel.send(JSON.stringify({ type: 'NEW_VIDEO', videoId: nextVideo.videoId, autoPlay: true }));
                }
            });
            // Update queue for everyone
            broadcastData({ type: 'QUEUE_UPDATE', queue: videoQueue });
            return;
        } else if (videoQueue.length === 0 && !upNextActive) {
            showUpNextOverlay();
            setTimeout(() => populateUpNextSuggestions(), 0);
        }
    }

    // Only hide overlay when playback resumes
    if (state === YT.PlayerState.PLAYING) {
        updateVideoTitle();
        hideUpNextOverlay();
        stopBufferingWatchdog(); // Video is playing, stop the watchdog
    } else if (state === YT.PlayerState.CUED) {
        updateVideoTitle();
    }

    // Start watchdog when buffering (in case it gets stuck)
    if (state === YT.PlayerState.BUFFERING) {
        startBufferingWatchdog();
    }

    if (isHost && intentToAutoPlay && state === YT.PlayerState.CUED) {
        intentToAutoPlay = false;
        handleUserAction({ type: 'STATE_CHANGE', state: YT.PlayerState.PLAYING, time: 0, userInitiated: true });
        startBufferingWatchdog(); // Start watchdog in case autoplay fails
        return;
    }

    // Detect in-iframe selection (e.g., end-screen click that navigates inside iframe)
    try {
        const vid = (player && typeof player.getVideoData === 'function') ? player.getVideoData().video_id : null;
        if (vid && currentVideoId && vid !== currentVideoId) {
            currentVideoId = vid;
            handleUserAction({ type: 'NEW_VIDEO', videoId: vid, autoPlay: true });
            return;
        }
    } catch (_) { /* ignore */ }

    // Ignore pure buffering
    if (state === YT.PlayerState.BUFFERING) return;

    // Suppress duplicate states EXCEPT allow ENDED to still propagate once (overlay handled above)
    if (state !== YT.PlayerState.ENDED && state === lastPlayerState) return;

    lastPlayerState = state;

    const userInitiated = (Date.now() - lastUserGestureAt) < 1500;

    if ((state === YT.PlayerState.PAUSED || state === YT.PlayerState.ENDED) &&
        document.hidden && !userInitiated) {
        return;
    }

    if (userInitiated) {
        lastUserActionTimestamp = Date.now();
    }

    if (isHost && state === YT.PlayerState.PLAYING) {
        const duration = player.getDuration();
        if (Math.abs(duration - officialVideoDuration) > 1) {
            officialVideoDuration = duration;
            broadcastData({ type: 'VIDEO_DURATION', duration: duration });
        }
    }

    const actionData = { type: 'STATE_CHANGE', state, time: player.getCurrentTime(), userInitiated };
    handleUserAction(actionData);
}

// Buffering watchdog - detects stuck buffering and forces playback
function startBufferingWatchdog() {
    // Clear any existing watchdog
    if (bufferingWatchdogTimeout) {
        clearTimeout(bufferingWatchdogTimeout);
    }
    
    // Check after 5 seconds if we're still buffering
    bufferingWatchdogTimeout = setTimeout(() => {
        if (!player || typeof player.getPlayerState !== 'function') return;
        
        const state = player.getPlayerState();
        const timeSinceUserAction = Date.now() - lastUserActionTimestamp;
        
        // If we're stuck buffering or unstarted, and user hasn't paused recently, force play
        if ((state === YT.PlayerState.BUFFERING || state === YT.PlayerState.UNSTARTED || state === YT.PlayerState.CUED) && 
            timeSinceUserAction > 3000) {
            player.playVideo();
            
            // Check again in 3 seconds
            bufferingWatchdogTimeout = setTimeout(() => {
                const newState = player.getPlayerState();
                if (newState === YT.PlayerState.BUFFERING || newState === YT.PlayerState.UNSTARTED) {
                    player.seekTo(0, true);
                    player.playVideo();
                }
            }, 3000);
        }
    }, 5000);
}

// Stop the watchdog when video is playing normally
function stopBufferingWatchdog() {
    if (bufferingWatchdogTimeout) {
        clearTimeout(bufferingWatchdogTimeout);
        bufferingWatchdogTimeout = null;
    }
}

function handleReceivedData(data, senderId, retryCount = 0) {
    // For video-related commands, ensure player is ready (retry if not, max 20 retries = 10 seconds)
    if (data.type.includes('VIDEO') || data.type === 'NEW_VIDEO' || data.type === 'INITIAL_SYNC' || data.type === 'STATE_CHANGE' || data.type === 'TIME_UPDATE') {
        if (!playerReady || !player || typeof player.loadVideoById !== 'function') {
            if (retryCount < 20) {
                if (retryCount === 0 || retryCount === 5 || retryCount === 10 || retryCount === 15) {
                    console.log(`[YT] Waiting for player... retry ${retryCount}/20, playerReady=${playerReady}, player=${!!player}, loadVideoById=${player ? typeof player.loadVideoById : 'N/A'}`);
                }
                setTimeout(() => handleReceivedData(data, senderId, retryCount + 1), 500);
            } else {
                console.error(`[${data.type}] Player failed to initialize after 10 seconds - playerReady=${playerReady}, player=${!!player}, loadVideoById=${player ? typeof player.loadVideoById : 'N/A'}`);
            }
            return;
        }
    }
    if (isHost && data.type.startsWith('REQUEST_')) {
        const commandData = { ...data, type: data.type.replace('REQUEST_', '') };
        broadcastData(commandData);
        return;
    }
    switch (data.type) {
        case 'HOST_INFO':
            currentHostId = data.hostId;
            break;
        case 'INITIAL_SYNC':
            officialVideoDuration = data.duration;
            if (player.getVideoData()?.video_id !== data.videoId) {
                player.loadVideoById(data.videoId, data.time);
            } else {
                player.seekTo(data.time, true);
            }
            // Track the synced video
            currentVideoId = data.videoId;
            hideUpNextOverlay();
            setTimeout(() => {
                if (data.state === YT.PlayerState.PLAYING) player.playVideo();
                else if (data.state === YT.PlayerState.PAUSED) player.pauseVideo();
            }, 1000);
            videoQueue = data.queue;
            updateQueueUI();
            break;
        case 'VIDEO_DURATION':
            officialVideoDuration = data.duration;
            break;
        case 'NEW_VIDEO':
            officialVideoDuration = 0;
            currentVideoId = data.videoId;
            hideUpNextOverlay();
            const currentPlayerVideoId = player.getVideoData?.()?.video_id;
            if (currentPlayerVideoId !== data.videoId) {
                if (data.autoPlay) {
                    intentToAutoPlay = true;
                }
                player.loadVideoById(data.videoId);
                startBufferingWatchdog();
            } else if (data.autoPlay) {
                player.playVideo();
                startBufferingWatchdog();
            }
            break;
        case 'STATE_CHANGE': {
            // Ignore ENDED state - only host handles video end/queue progression via NEW_VIDEO
            if (data.state === YT.PlayerState.ENDED) break;
            
            lastPlayerState = data.state;
            if (data.state === YT.PlayerState.PLAYING) {
                const timeDifference = Math.abs(player.getCurrentTime() - data.time);
                if (timeDifference > 1.5) {
                    player.seekTo(data.time, true);
                }
                player.playVideo();
            } else if (data.state === YT.PlayerState.PAUSED) {
                player.pauseVideo();
            }
            break;
        }
        case 'TIME_UPDATE':
            if (!isHost) {
                if (Date.now() - lastUserActionTimestamp < 3000) break;
                const localTime = player.getCurrentTime();
                const localState = player.getPlayerState();
                const timeDifference = Math.abs(localTime - data.time);
                if (data.state === YT.PlayerState.PLAYING && (localState !== YT.PlayerState.PLAYING || timeDifference > 3.5)) {
                    const currentDuration = player.getDuration();
                    if (officialVideoDuration > 0 && Math.abs(currentDuration - officialVideoDuration) > 2) {
                        break;
                    }
                    player.seekTo(data.time, true);
                    player.playVideo();
                }
                else if (data.state === YT.PlayerState.PAUSED && localState !== YT.PlayerState.PAUSED) {
                    console.log("Heartbeat correcting to PAUSED state.");
                    player.pauseVideo();
                }
            }
            break;
        case 'ADD_TO_QUEUE':
            if (isHost) {
                videoQueue.push(data.video);
                broadcastData({ type: 'QUEUE_UPDATE', queue: videoQueue });
            }
            break;
        case 'PLAY_FROM_QUEUE':
            if (isHost && videoQueue[data.index]) {
                const videoToPlay = videoQueue.splice(data.index, 1)[0];
                broadcastData({ type: 'NEW_VIDEO', videoId: videoToPlay.videoId, autoPlay: true });
                broadcastData({ type: 'QUEUE_UPDATE', queue: videoQueue });
            }
            break;
        case 'REMOVE_FROM_QUEUE':
            if (isHost) {
                videoQueue.splice(data.index, 1);
                broadcastData({ type: 'QUEUE_UPDATE', queue: videoQueue });
            }
            break;
        case 'SHUFFLE_QUEUE':
            if (isHost && videoQueue.length > 1) {
                // Fisher-Yates shuffle
                for (let i = videoQueue.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [videoQueue[i], videoQueue[j]] = [videoQueue[j], videoQueue[i]];
                }
                broadcastData({ type: 'QUEUE_UPDATE', queue: videoQueue });
            }
            break;
        case 'TOGGLE_QUEUE_VISIBILITY':
            if (isHost) {
                queueHidden = !queueHidden;
                updateQueueVisibility();
                broadcastData({ type: 'QUEUE_VISIBILITY', hidden: queueHidden });
            }
            break;
        case 'QUEUE_VISIBILITY':
            queueHidden = data.hidden;
            updateQueueVisibility();
            break;
        case 'TOGGLE_RANDOM_PLAY':
            if (isHost) {
                randomPlayMode = !randomPlayMode;
                updateRandomPlayUI();
                // Also hide queue when enabling random play
                if (randomPlayMode && !queueHidden) {
                    queueHidden = true;
                    updateQueueVisibility();
                    broadcastData({ type: 'QUEUE_VISIBILITY', hidden: queueHidden });
                }
                broadcastData({ type: 'RANDOM_PLAY_MODE', enabled: randomPlayMode });
            }
            break;
        case 'RANDOM_PLAY_MODE':
            randomPlayMode = data.enabled;
            updateRandomPlayUI();
            break;
        case 'USER_LEAVING':
            if (isHost && peerConnections[senderId]) {
                peerConnections[senderId].close();
            }
            break;
        case 'QUEUE_UPDATE':
            videoQueue = data.queue;
            updateQueueUI();
            break;
        case 'USER_LIST':
            updateUserList(data.users);
            break;
    }
}

// Copy invite link handler
copyInviteBtn.addEventListener('click', async () => {
    const link = inviteLinkInput.value;
    if (!link) return;
    try {
        await navigator.clipboard.writeText(link);
        copyInviteBtn.textContent = 'Copied!';
        setTimeout(() => (copyInviteBtn.textContent = 'Copy'), 1500);
    } catch (err) {
        // Fallback for non-secure contexts
        inviteLinkInput.select();
        inviteLinkInput.setSelectionRange(0, link.length);
        const success = document.execCommand && document.execCommand('copy');
        copyInviteBtn.textContent = success ? 'Copied!' : 'Copy failed';
        setTimeout(() => (copyInviteBtn.textContent = 'Copy'), 1500);
        if (window.getSelection) window.getSelection().removeAllRanges();
    }
});

// Shuffle queue handler
shuffleQueueBtn.addEventListener('click', () => {
    if (videoQueue.length < 2) return;
    handleUserAction({ type: 'SHUFFLE_QUEUE' });
});

// Hide queue handler (host only)
hideQueueBtn.addEventListener('click', () => {
    if (!isHost) return;
    handleUserAction({ type: 'TOGGLE_QUEUE_VISIBILITY' });
});

// Random play handler (host only)
randomPlayBtn.addEventListener('click', () => {
    if (!isHost) return;
    handleUserAction({ type: 'TOGGLE_RANDOM_PLAY' });
});

// Update queue visibility UI
function updateQueueVisibility() {
    if (queueHidden) {
        queueList.classList.add('queue-hidden');
        hideQueueBtn.classList.add('active');
        hideQueueBtn.title = 'Show Queue for Everyone';
    } else {
        queueList.classList.remove('queue-hidden');
        hideQueueBtn.classList.remove('active');
        hideQueueBtn.title = 'Hide Queue for Everyone';
    }
}

// Update random play UI
function updateRandomPlayUI() {
    if (randomPlayMode) {
        randomPlayBtn.classList.add('active');
        randomPlayBtn.title = 'Disable Random Play Mode';
    } else {
        randomPlayBtn.classList.remove('active');
        randomPlayBtn.title = 'Enable Random Play Mode';
    }
}

function startHostHeartbeat() {
    if (hostHeartbeatInterval) clearInterval(hostHeartbeatInterval);
    hostHeartbeatInterval = setInterval(() => {
        if (isHost && player && typeof player.getCurrentTime === 'function') {
            const currentState = player.getPlayerState();
            if (currentState === YT.PlayerState.ENDED && videoQueue.length > 0) {
                // If random play mode, shuffle queue before picking next video
                if (randomPlayMode && videoQueue.length > 1) {
                    for (let i = videoQueue.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [videoQueue[i], videoQueue[j]] = [videoQueue[j], videoQueue[i]];
                    }
                }
                const nextVideo = videoQueue.shift();
                hideUpNextOverlay();
                broadcastData({ type: 'NEW_VIDEO', videoId: nextVideo.videoId, autoPlay: true });
                broadcastData({ type: 'QUEUE_UPDATE', queue: videoQueue });
                return;
            }
            const data = { type: 'TIME_UPDATE', time: player.getCurrentTime(), state: currentState };
            Object.entries(dataChannels).forEach(([id, channel]) => {
                if (id !== 'host' && channel && channel.readyState === 'open') {
                    channel.send(JSON.stringify(data));
                }
            });
        }
    }, 1500);
}

async function handleHostDisconnection() {
    // Show reconnection overlay
    if (reconnectOverlay) {
        reconnectOverlay.classList.remove('hidden');
        if (reconnectMessage) reconnectMessage.textContent = 'Host disconnected, electing new host...';
    }

    resetPartyState();
    console.log("Host disconnected. Starting election...");
    connectionStatus.textContent = 'Status: Host disconnected, electing new host...';
    connectionStatus.className = 'status connecting';
    if (hostHeartbeatInterval) clearInterval(hostHeartbeatInterval);

    const remainingClientIds = Object.keys(localUserList);
    if (!remainingClientIds.includes(myAuthId)) {
        remainingClientIds.push(myAuthId);
    }
    remainingClientIds.sort();

    if (remainingClientIds.length === 0) {
        console.log("Party is empty after host left.");
        if (reconnectOverlay) reconnectOverlay.classList.add('hidden');
        return;
    }

    const newHostId = remainingClientIds[0];
    console.log("Election determined. New host should be:", newHostId);

    if (myAuthId === newHostId) {
        try {
            const guestsSnapshot = await partyDocRef.collection('guests').get();
            const batch = db.batch();
            guestsSnapshot.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
            console.log("Cleared old guest list from Firestore.");

            await partyDocRef.update({ hostId: myAuthId });
            console.log("This client has successfully become the new host!");
            isHost = true;
            document.body.classList.add('is-host');
            currentHostId = myAuthId;
            updateUIForNewHost();
            listenForGuests();
            startHostHeartbeat();
            broadcastData({ type: 'USER_LIST', users: localUserList });

            // Hide reconnection overlay
            if (reconnectOverlay) reconnectOverlay.classList.add('hidden');

        } catch (error) {
            console.error("Error trying to become host:", error);
            alert("Could not elect new host. Please refresh the page.");
            if (reconnectOverlay) reconnectOverlay.classList.add('hidden');
        }
    } else {
        console.log("Waiting for the new host to take over.");
        if (reconnectMessage) reconnectMessage.textContent = 'Reconnecting to new host...';
        listenForNewHostAndReconnect();
    }
}

function listenForNewHostAndReconnect() {
    const unsubscribe = partyDocRef.onSnapshot(doc => {
        if (!doc.exists) return;
        const newHostId = doc.data().hostId;
        if (newHostId && newHostId !== myAuthId && newHostId !== currentHostId) {
            console.log(`New host detected (${newHostId}). Reconnecting...`);
            unsubscribe();
            currentHostId = newHostId;
            joinParty();
        }
    });
}

function updateUIForNewHost() {
    createInviteBtn.classList.remove('hidden');
    createInviteBtn.disabled = true;
    updateUserList(localUserList);
    updateConnectionStatus();
}

function updateVideoTitle() {
    if (player && typeof player.getVideoData === 'function') {
        const title = player.getVideoData().title;
        if (title) {
            videoTitleElement.textContent = title;
            videoTitleElement.title = title;
        }
    }
}

function updateQueueUI() {
    queueList.innerHTML = '';
    if (videoQueue.length === 0) {
        queueList.innerHTML = '<li>Queue is empty.</li>';
        return;
    }
    videoQueue.forEach((video, index) => {
        const li = document.createElement('li');
        li.title = "Click to Play Now";
        li.innerHTML = `<img src="${video.thumbnailUrl}" alt="${video.title}"><div class="video-info"><div class="video-title">${video.title}</div><button class="remove-btn" title="Remove from queue" data-index="${index}">Remove</button></div>`;
        li.addEventListener('click', (e) => {
            if (e.target.classList.contains('remove-btn')) return;
            handleUserAction({ type: 'PLAY_FROM_QUEUE', index });
        });
        li.querySelector('.remove-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            handleUserAction({ type: 'REMOVE_FROM_QUEUE', index });
        });
        queueList.appendChild(li);
    });
}

function updateConnectionStatus() {
    const states = Object.values(peerConnections).map(pc => pc.connectionState);
    let statusText = 'Disconnected';
    let statusClass = 'disconnected';
    const connectedCount = states.filter(s => s === 'connected').length;
    if (isHost && states.length === 0) {
        statusText = 'Waiting for guests...';
        statusClass = 'connecting';
    } else if (connectedCount > 0 || (!isHost && peerConnections['host'] && peerConnections['host'].connectionState === 'connected')) {
        statusText = 'Connected';
        statusClass = 'connected';
    } else if (!isHost && states.some(s => ['connecting', 'new', 'checking'].includes(s))) {
        statusText = 'Connecting...';
        statusClass = 'connecting';
    }
    // Show just "Connected" when connected; otherwise keep the "Status: ..." prefix
    connectionStatus.textContent = statusClass === 'connected' ? 'Connected' : `Status: ${statusText}`;
    connectionStatus.className = `status ${statusClass}`;
    
    // Update body class for host-only UI elements
    document.body.classList.toggle('is-host', isHost);
}

function updateUserList(users = {}) {
    localUserList = users;
    userList.innerHTML = '';
    const uniqueUsers = {};
    Object.values(users).forEach(user => {
        if (user.name && !uniqueUsers[user.name]) {
            uniqueUsers[user.name] = user;
        }
    });
    if (!uniqueUsers[myName]) {
        uniqueUsers[myName] = { name: myName };
    }
    Object.values(uniqueUsers).forEach(user => {
        const li = document.createElement('li');
        let suffix = '';
        if (user.name === myName) {
            suffix = isHost ? ' (Host, You)' : ' (You)';
        }
        li.textContent = user.name + suffix;
        userList.appendChild(li);
    });
}
