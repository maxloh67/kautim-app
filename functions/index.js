const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");

const VISION_API_KEY = defineSecret("VISION_API_KEY");

exports.scanReceipt = onRequest(
    {secrets: [VISION_API_KEY], cors: true},
    async (req, res) => {
      if (req.method !== "POST") {
        return res.status(405).json({error: "Use POST"});
      }

      try {
        const {imageBase64} = req.body;
        if (!imageBase64) {
          return res.status(400).json({error: "Missing imageBase64"});
        }

        const visionRes = await fetch(
            `https://vision.googleapis.com/v1/images:annotate?key=${VISION_API_KEY.value()}`,
            {
              method: "POST",
              headers: {"Content-Type": "application/json"},
              body: JSON.stringify({
                requests: [
                  {
                    image: {content: imageBase64},
                    features: [{type: "DOCUMENT_TEXT_DETECTION"}],
                  },
                ],
              }),
            },
        );

        const data = await visionRes.json();

        if (!visionRes.ok || data.responses?.[0]?.error) {
          console.error("Vision error:", data);
          return res.status(500).json({
            error: "Vision API error",
            detail: data,
          });
        }

        const text = data.responses?.[0]?.fullTextAnnotation?.text || "";
        res.json({text});
      } catch (err) {
        console.error("scanReceipt failed:", err);
        res.status(500).json({error: "Internal error"});
      }
    },
);
