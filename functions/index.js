// functions/index.js - v6
const functions = require("firebase-functions/v2");
const { onCall } = require("firebase-functions/v2/https");
const axios = require("axios");

// Get TURN credentials from Cloudflare Calls
exports.getTurnCredentials = onCall(async (request) => {
  const appId = process.env.CLOUDFLARE_TURN_APP_ID;
  const appSecret = process.env.CLOUDFLARE_TURN_APP_SECRET;

  if (!appId || !appSecret) {
    console.error("Cloudflare TURN credentials not configured");
    throw new functions.https.HttpsError(
      "failed-precondition",
      "TURN server not configured",
    );
  }

  try {
    // Generate short-lived credentials (valid for 24 hours)
    const response = await axios.post(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${appId}/credentials/generate`,
      { ttl: 86400 }, // 24 hours in seconds
      {
        headers: {
          "Authorization": `Bearer ${appSecret}`,
          "Content-Type": "application/json",
        },
      },
    );

    const { iceServers } = response.data;
    console.log("Generated TURN credentials successfully");
    return { iceServers };
  } catch (error) {
    console.error("Error generating TURN credentials:", error.message);
    // Return fallback public STUN servers if Cloudflare fails
    return {
      iceServers: [
        { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
      ],
    };
  }
});

exports.searchYoutube = onCall(async (request) => {
  // Read the API key from environment variables
  const apiKey = process.env.SECRETS_KEY;

  // Debug: log the first/last 4 chars of the API key
  const keyPreview = apiKey ? `${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)}` : "UNDEFINED";
  console.log("API Key preview:", keyPreview);

  const videoId = request.data.videoId;
  const playlistId = request.data.playlistId;
  const searchQuery = request.data.query;
  // 'video', 'playlist', or 'video,playlist'
  const searchType = request.data.searchType || "video";

  try {
    let response;
    if (videoId) {
      // If a videoId is provided, use the 'videos.list' endpoint
      response = await axios.get(
        "https://www.googleapis.com/youtube/v3/videos", {
          params: {
            part: "snippet,contentDetails",
            id: videoId,
            key: apiKey,
          },
        });
    } else if (playlistId) {
      // If a playlistId is provided, get playlist details
      const playlistResponse = await axios.get(
        "https://www.googleapis.com/youtube/v3/playlists", {
          params: {
            part: "snippet,contentDetails",
            id: playlistId,
            key: apiKey,
          },
        });

      // Also get the playlist items (videos in the playlist)
      const playlistItemsResponse = await axios.get(
        "https://www.googleapis.com/youtube/v3/playlistItems", {
          params: {
            part: "snippet,contentDetails",
            playlistId: playlistId,
            key: apiKey,
            maxResults: 50,
          },
        });

      // Combine playlist info with its items
      return {
        playlist: playlistResponse.data.items[0],
        items: playlistItemsResponse.data.items,
      };
    } else if (searchQuery) {
      // Search endpoint - can search for videos, playlists, or both
      const searchResponse = await axios.get(
        "https://www.googleapis.com/youtube/v3/search", {
          params: {
            part: "snippet",
            q: searchQuery,
            key: apiKey,
            type: searchType,
            maxResults: 10, // Reduced from 20 to save quota
          },
        });

      // Separate videos and playlists
      const videoIds = [];
      const playlistIds = [];
      const results = [];

      searchResponse.data.items.forEach((item) => {
        if (item.id.kind === "youtube#video") {
          videoIds.push(item.id.videoId);
        } else if (item.id.kind === "youtube#playlist") {
          playlistIds.push(item.id.playlistId);
          results.push(item); // Keep playlists as-is
        }
      });

      // Get full details for videos
      if (videoIds.length > 0) {
        const videosResponse = await axios.get(
          "https://www.googleapis.com/youtube/v3/videos", {
            params: {
              part: "snippet,contentDetails",
              id: videoIds.join(","),
              key: apiKey,
            },
          });
        results.push(...videosResponse.data.items);
      }

      // Get full details for playlists
      if (playlistIds.length > 0) {
        const playlistsResponse = await axios.get(
          "https://www.googleapis.com/youtube/v3/playlists", {
            params: {
              part: "snippet,contentDetails",
              id: playlistIds.join(","),
              key: apiKey,
            },
          });
          // Replace search results with full playlist details
        results.forEach((item, index) => {
          if (item.id.kind === "youtube#playlist") {
            const fullPlaylist = playlistsResponse.data.items.find(
              (p) => p.id === item.id.playlistId,
            );
            if (fullPlaylist) {
              results[index] = fullPlaylist;
            }
          }
        });
      }

      return { items: results };
    } else {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Request must contain 'query', 'videoId', or 'playlistId'.",
      );
    }
    return response.data;
  } catch (error) {
    console.error("Error fetching from YouTube API:", error.message);
    throw new functions.https.HttpsError(
      "internal",
      "Failed to fetch from YouTube API. Check API key and permissions.",
    );
  }
});
