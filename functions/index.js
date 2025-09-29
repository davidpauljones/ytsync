// functions/index.js
const functions = require("firebase-functions/v2");
const {onCall} = require("firebase-functions/v2/https");
const axios = require("axios");

exports.searchYoutube = onCall(async (request) => {
  // Read the secret key from the environment variables
  const apiKey = process.env.SECRETS_KEY;

  const videoId = request.data.videoId;
  const searchQuery = request.data.query;

  try {
    let response;
    if (videoId) {
      // If a videoId is provided, use the 'videos.list' endpoint
      response = await axios.get(
          "https://www.googleapis.com/youtube/v3/videos", {
            params: {
              part: "snippet",
              id: videoId,
              key: apiKey,
            },
          });
    } else if (searchQuery) {
      // Otherwise, use the 'search.list' endpoint
      response = await axios.get(
          "https://www.googleapis.com/youtube/v3/search", {
            params: {
              part: "snippet",
              q: searchQuery,
              key: apiKey,
              type: "video",
              maxResults: 20,
            },
          });
    } else {
      throw new functions.https.HttpsError(
          "invalid-argument",
          "Request must contain either a 'query' or a 'videoId'.",
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
