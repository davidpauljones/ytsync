// functions/index.js
const functions = require("firebase-functions/v2"); // Use v2
const {onCall} = require("firebase-functions/v2/https"); // Use v2
const {defineString} = require("firebase-functions/params");
const axios = require("axios");

// 1. DECLARE the secret variable we need.
const YOUTUBE_API_KEY = defineString("YOUTUBE_API_KEY");

exports.searchYoutube = onCall(async (request) => {
  // Get the search query from the request data
  const searchQuery = request.data.query;

  // 2. USE the secret variable's value.
  const apiKey = YOUTUBE_API_KEY.value();

  if (!searchQuery) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "The function must be called with a 'query' argument.",
    );
  }

  const YOUTUBE_API_URL = "https://www.googleapis.com/youtube/v3/search";

  try {
    const response = await axios.get(YOUTUBE_API_URL, {
      params: {
        part: "snippet",
        q: searchQuery,
        key: apiKey,
        type: "video",
        maxResults: 10,
      },
    });
    return response.data;
  } catch (error) {
    console.error("Error fetching from YouTube API:", error.message);
    throw new functions.https.HttpsError(
        "internal",
        "Failed to fetch search results. Check project permissions.",
    );
  }
});
