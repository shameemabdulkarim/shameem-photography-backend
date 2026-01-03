const express = require("express");
const cors = require("cors");
require("dotenv").config();
const cloudinary = require("cloudinary").v2;
const { Resend } = require("resend");

const app = express();

// Configure Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Middleware
app.use(cors());
app.use(express.json()); // Parse JSON request bodies

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Simple in-memory cache
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

function getCacheKey(category, page) {
  return `${category || "all"}_page_${page}`;
}

function isCacheValid(timestamp) {
  return Date.now() - timestamp < CACHE_DURATION;
}

app.get("/api/images", async (req, res) => {
  try {
    const { page = 1, limit = 8, category } = req.query;

    // Check cache first
    const cacheKey = getCacheKey(category, page);
    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      if (isCacheValid(cached.timestamp)) {
        console.log(`📦 Cache hit for ${cacheKey}`);
        return res.json(cached.data);
      } else {
        cache.delete(cacheKey);
      }
    }

    let expression = "resource_type:image";
    if (category && category !== "all") {
      expression = `resource_type:image AND tags:${category}`;
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const maxResults = Math.min(offset + parseInt(limit), 500); // Cloudinary max is 500

    let searchQuery = cloudinary.search
      .expression(expression)
      .sort_by("uploaded_at", "desc")
      .max_results(maxResults)
      .with_field("tags")
      .with_field("context");

    const result = await searchQuery.execute();
    
    // Manually slice the results for pagination
    const paginatedResources = result.resources.slice(offset, offset + parseInt(limit));

    // Helper function to determine height category based on aspect ratio
    const getHeightCategory = (width, height) => {
      if (!width || !height) return "square";
      
      const aspectRatio = height / width;
      
      // Portrait/Vertical images (taller than wide)
      if (aspectRatio > 1.4) return "tall";        // Very tall images (6 row spans)
      if (aspectRatio > 1.15) return "medium";     // Moderately tall (5 row spans)
      
      // Landscape/Horizontal images (wider than tall)
      if (aspectRatio < 0.7) return "short";       // Very wide images (3 row spans)
      
      // Square-ish images (roughly equal dimensions)
      return "square";                              // Square images (4 row spans)
    };

    const images = paginatedResources
      .filter((img) => img.tags && img.tags.length > 0)
      .map((img) => ({
        id: img.public_id,
        title: img.context?.caption || img.public_id,
        category: img.tags[0],
        blobUrl: img.secure_url,
        height: getHeightCategory(img.width, img.height),
        // Include dimensions for debugging (optional)
        dimensions: { width: img.width, height: img.height },
      }));

    const responseData = {
      images,
      hasMore: offset + images.length < result.total_count,
      totalCount: result.total_count,
    };

    // Store in cache
    cache.set(cacheKey, {
      data: responseData,
      timestamp: Date.now(),
    });

    res.json(responseData);
  } catch (error) {
    console.error("Cloudinary error:", error);

    // Return cached data if available, even if expired
    const cacheKey = getCacheKey(req.query.category, req.query.page);
    if (cache.has(cacheKey)) {
      console.warn(`⚠️ Using stale cache due to error`);
      return res.json(cache.get(cacheKey).data);
    }

    res.status(500).json({ error: error.message });
  }
});

// Email sending endpoint
app.post("/api/send-email", async (req, res) => {
  try {
    const { name, email, date, timeSlot, shootType, package: packageName, message } = req.body;

    // Validate required fields
    if (!name || !email || !date || !shootType || !packageName) {
      return res.status(400).json({ 
        error: "Missing required fields",
        required: ["name", "email", "date", "shootType", "package"]
      });
    }

    // Send email using Resend
    // Send emails in parallel
    const [adminEmail, userEmail] = await Promise.all([
      // Admin Notification
      resend.emails.send({
        from: 'info@shaszstudios.nl',
        to: 'info@shaszstudios.nl',
        reply_to: email, 
        subject: `New Booking Request - ${shootType} on ${date}`,
        html: `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: linear-gradient(135deg, #14b8a6 0%, #0f766e 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
              .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
              .field { margin-bottom: 15px; padding: 15px; background: white; border-radius: 5px; border-left: 4px solid #14b8a6; }
              .label { font-weight: bold; color: #0f766e; margin-bottom: 5px; }
              .value { color: #333; }
              .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 14px; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1 style="margin: 0;">📸 New Booking Request</h1>
                <p style="margin: 10px 0 0 0; opacity: 0.9;">Shameem Photography</p>
              </div>
              <div class="content">
                <div class="field">
                  <div class="label">Customer Name</div>
                  <div class="value">${name}</div>
                </div>
                <div class="field">
                  <div class="label">Email Address</div>
                  <div class="value"><a href="mailto:${email}" style="color: #14b8a6;">${email}</a></div>
                </div>
                <div class="field">
                  <div class="label">Preferred Date</div>
                  <div class="value">${date}</div>
                </div>
                ${timeSlot ? `
                <div class="field">
                  <div class="label">Time Slot</div>
                  <div class="value">${timeSlot}</div>
                </div>
                ` : ''}
                <div class="field">
                  <div class="label">Session Type</div>
                  <div class="value">${shootType}</div>
                </div>
                <div class="field">
                  <div class="label">Package Selected</div>
                  <div class="value">${packageName}</div>
                </div>
                ${message ? `
                <div class="field">
                  <div class="label">Additional Information</div>
                  <div class="value">${message}</div>
                </div>
                ` : ''}
                <div class="footer">
                  <p>This is an automated booking notification from your website.</p>
                  <p>Reply directly to this email to contact ${name}.</p>
                </div>
              </div>
            </div>
          </body>
        </html>
      `,
      }),
      // User Acknowledgment
      resend.emails.send({
        from: 'info@shaszstudios.nl',
        to: email,
        subject: `Booking Request Received - Shameem Photography`,
        html: `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: linear-gradient(135deg, #14b8a6 0%, #0f766e 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
              .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
              .message-box { background: white; padding: 20px; border-radius: 5px; border-left: 4px solid #14b8a6; margin-bottom: 20px; }
              .summary-title { font-weight: bold; color: #0f766e; margin-bottom: 10px; font-size: 1.1em; border-bottom: 1px solid #e5e7eb; padding-bottom: 5px; }
              .summary-item { margin-bottom: 8px; display: flex; }
              .summary-label { font-weight: bold; width: 120px; color: #4b5563; }
              .summary-value { flex: 1; color: #111827; }
              .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 14px; border-top: 1px solid #e5e7eb; padding-top: 20px; }
              .social-links { margin-top: 15px; }
              .social-link { display: inline-block; margin: 0 5px; color: #14b8a6; text-decoration: none; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1 style="margin: 0;">Booking Received!</h1>
                <p style="margin: 10px 0 0 0; opacity: 0.9;">Shameem Photography</p>
              </div>
              <div class="content">
                <div class="message-box">
                  <p style="margin-top: 0;">Dear ${name},</p>
                  <p>Thank you for your booking request! I have received your inquiry and will get back to you as soon as possible to confirm the details.</p>
                  <p style="margin-bottom: 0;">In the meantime, here is a summary of your request:</p>
                </div>
                
                <div style="background: white; padding: 20px; border-radius: 5px;">
                  <div class="summary-title">Booking Details</div>
                  <div class="summary-item">
                    <span class="summary-label">Date:</span>
                    <span class="summary-value">${date}</span>
                  </div>
                  ${timeSlot ? `
                  <div class="summary-item">
                    <span class="summary-label">Time Slot:</span>
                    <span class="summary-value">${timeSlot}</span>
                  </div>
                  ` : ''}
                  <div class="summary-item">
                    <span class="summary-label">Session Type:</span>
                    <span class="summary-value">${shootType}</span>
                  </div>
                  <div class="summary-item">
                    <span class="summary-label">Package:</span>
                    <span class="summary-value">${packageName}</span>
                  </div>
                </div>

                <div class="footer">
                  <p>Have questions? Reply correctly to this email.</p>
                  <p>Thanks for choosing Shameem Photography!</p>
                  <div class="social-links">
                    <a href="https://shaszstudios.nl" class="social-link">Website</a> | 
                    <a href="https://instagram.com/shaszstudios" class="social-link">Instagram</a>
                  </div>
                </div>
              </div>
            </div>
          </body>
        </html>
        `
      })
    ]);

    if (adminEmail.error || userEmail.error) {
       console.error("❌ Resend API Error:", adminEmail.error || userEmail.error);
       throw new Error(adminEmail.error?.message || userEmail.error?.message);
    }

    console.log("✅ Emails sent successfully. Admin ID:", adminEmail.data?.id, "User ID:", userEmail.data?.id);
    res.json({ 
      success: true, 
      message: "Booking emails sent successfully",
      messageId: adminEmail.data?.id 
    });

  } catch (error) {
    console.error("❌ Email sending error:", error);
    res.status(500).json({ 
      error: "Failed to send email",
      details: error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
