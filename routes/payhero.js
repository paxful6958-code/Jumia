const express = require("express");
const axios = require("axios");

const router = express.Router();

const PAYHERO_BASE_URL = "https://backend.payhero.co.ke/api/v2";

const {
    PAYHERO_API_USERNAME,
    PAYHERO_API_PASSWORD,
    PAYHERO_BASIC_TOKEN, // optional: full "Basic xxx" token from dashboard
    PAYHERO_CHANNEL_ID,
    PAYHERO_CALLBACK_URL
} = process.env;

// ---------------------------------------------------------------------
// Build the Authorization header.
// Option A (recommended): paste the full Basic Auth Token from the
// PayHero dashboard (Profile -> API Keys) into PAYHERO_BASIC_TOKEN.
// Option B: paste the raw API Username + API Password separately.
// ---------------------------------------------------------------------
function buildAuthConfig() {
    if (PAYHERO_BASIC_TOKEN && PAYHERO_BASIC_TOKEN.trim() !== "") {
        // Accept either "Basic xxxxx" or a bare token
        const token = PAYHERO_BASIC_TOKEN.trim().replace(/^Basic\s+/i, "");
        return { headers: { Authorization: `Basic ${token}` } };
    }

    if (PAYHERO_API_USERNAME && PAYHERO_API_PASSWORD) {
        return { auth: { username: PAYHERO_API_USERNAME, password: PAYHERO_API_PASSWORD } };
    }

    return null;
}

const authConfig = buildAuthConfig();

if (!authConfig || !PAYHERO_CHANNEL_ID) {
    console.warn(
        "⚠️ PayHero credentials missing. Set PAYHERO_BASIC_TOKEN (or PAYHERO_API_USERNAME + PAYHERO_API_PASSWORD) and PAYHERO_CHANNEL_ID in .env"
    );
}

// channel_id MUST be an integer per PayHero docs
const CHANNEL_ID = Number(PAYHERO_CHANNEL_ID);

// Basic phone sanity check: 2547XXXXXXXX or 2541XXXXXXXX
function isValidKenyanPhone(phone) {
    return typeof phone === "string" && /^254(7|1)\d{8}$/.test(phone);
}

router.post("/stk-push", async(req, res) => {
    try {
        if (!authConfig) {
            return res.status(500).json({
                success: false,
                message: "Server not configured: PayHero credentials missing in .env"
            });
        }

        if (!Number.isInteger(CHANNEL_ID) || CHANNEL_ID <= 0) {
            return res.status(500).json({
                success: false,
                message: "Server not configured: PAYHERO_CHANNEL_ID must be a numeric channel ID (e.g. 133)"
            });
        }

        const { phone_number, amount, customer_name } = req.body;

        if (!phone_number || !amount) {
            return res.status(400).json({
                success: false,
                message: "Phone number and amount are required"
            });
        }

        const phone = String(phone_number).replace(/\D/g, "");
        if (!isValidKenyanPhone(phone)) {
            return res.status(400).json({
                success: false,
                message: "Invalid phone number. Use format 2547XXXXXXXX or 2541XXXXXXXX."
            });
        }

        const numericAmount = Number(amount);
        if (!Number.isInteger(numericAmount) || numericAmount < 1) {
            return res.status(400).json({
                success: false,
                message: "Amount must be a positive whole number (KES)."
            });
        }

        const externalReference = `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

        const payload = {
            amount: numericAmount,
            phone_number: phone,
            channel_id: CHANNEL_ID, // integer, per PayHero docs
            provider: "m-pesa",
            external_reference: externalReference
        };

        // Optional fields — only include if actually configured
        if (customer_name && typeof customer_name === "string") {
            payload.customer_name = customer_name;
        }
        if (PAYHERO_CALLBACK_URL && PAYHERO_CALLBACK_URL.startsWith("https://")) {
            payload.callback_url = PAYHERO_CALLBACK_URL;
        }

        const response = await axios.post(
            `${PAYHERO_BASE_URL}/payments`,
            payload, {
                ...authConfig,
                headers: {
                    ...(authConfig.headers || {}),
                    "Content-Type": "application/json"
                },
                timeout: 30000
            }
        );

        console.log(`STK push queued | ref=${externalReference} | phone=${phone} | amount=${numericAmount}`);

        return res.json({
            success: true,
            message: "STK Push sent successfully. Check your phone and enter your M-Pesa PIN.",
            data: {
                external_reference: externalReference,
                order_tracking_id: response.data.order_tracking_id || null,
                reference: response.data.reference || null,
                status: response.data.status || "QUEUED"
            }
        });

    } catch (error) {
        // Full visibility into what PayHero actually rejected
        if (error.response) {
            console.error("STK ERROR status:", error.response.status);
            console.error("STK ERROR body:", JSON.stringify(error.response.data, null, 2));
        } else {
            console.error("STK ERROR (network/config):", error.message);
        }

        const status = error.response ? error.response.status : 500;
        const errorMessage =
            error.response &&
            error.response.data &&
            (error.response.data.message ||
                error.response.data.errorMessage ||
                (typeof error.response.data === "string" ? error.response.data : null));

        return res.status(status === 400 ? 400 : 500).json({
            success: false,
            message: errorMessage || error.message || "Payment initiation failed"
        });
    }
});

// PayHero posts payment status here — must be publicly reachable over HTTPS
router.post("/payhero-callback", async(req, res) => {
    console.log("PayHero Callback:", JSON.stringify(req.body));

    try {
        const callback = req.body;
        const stkCallback =
            callback.ResponseCode !== undefined ?
            callback :
            (callback.Body && callback.Body.stkCallback) || callback;

        // TODO: Locate transaction by external_reference and record
        // the payment result (ResultCode === 0 means success).

        res.sendStatus(200);
    } catch (err) {
        console.error("Callback processing error:", err.message);
        res.sendStatus(200);
    }
});

module.exports = router;