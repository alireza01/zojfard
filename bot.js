// main.js
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { DateTime } from "https://esm.sh/luxon@3.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsPDF } from "https://esm.sh/jspdf@2.5.1";
import { default as autoTable } from 'https://esm.sh/jspdf-autotable@3.8.2';
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts"; // Corrected import
// --- Configuration ---
const BOT_TOKEN = Deno.env.get("BOT_TOKEN") || "YOUR_BOT_TOKEN"; // REQUIRED
const ADMIN_CHAT_ID = Deno.env.get("ADMIN_CHAT_ID") || "YOUR_ADMIN_CHAT_ID"; // REQUIRED
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "YOUR_SUPABASE_URL"; // REQUIRED
const SUPABASE_KEY = Deno.env.get("SUPABASE_KEY") || "YOUR_SUPABASE_KEY"; // REQUIRED (Service Role Key)
const TELEGRAM_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TEHRAN_TIMEZONE = "Asia/Tehran";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// --- Reference Point for Week Calculation ---
const REFERENCE_PERSIAN_YEAR = 1403;
const REFERENCE_PERSIAN_MONTH = 11; // بهمن
const REFERENCE_PERSIAN_DAY = 20;
const REFERENCE_STATUS = "فرد"; // "فرد" (odd) or "زوج" (even)
// --- Constants ---
const PERSIAN_WEEKDAYS = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه"]; // Relevant weekdays
const PERSIAN_WEEKDAYS_FULL = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنج‌شنبه", "جمعه"];
const ENGLISH_WEEKDAYS = ["saturday", "sunday", "monday", "tuesday", "wednesday"];
const SCHEDULE_TIME_REGEX = /^(?:[01]\d|2[0-3]|[89]):[0-5]\d$/; // HH:MM or H:MM
const LUNCH_START_MINUTES = 12 * 60;
const LUNCH_END_MINUTES = 13 * 60;
const LRM = "\u200E"; // Left-to-Right Mark for PDF text
// --- Supabase Setup ---
if (!SUPABASE_URL || !SUPABASE_KEY || !BOT_TOKEN || !ADMIN_CHAT_ID) {
    console.error("CRITICAL ERROR: Required environment variables (BOT_TOKEN, ADMIN_CHAT_ID, SUPABASE_URL, SUPABASE_KEY) are missing.");
    throw new Error("Essential configuration is incomplete.");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
    }
});
// --- Deno KV Setup ---
const kv = await Deno.openKv();
// --- Pre-calculate Gregorian Reference Date ---
let REFERENCE_DATE_GREGORIAN;
try {
    const refGregorianArray = jalaliToGregorian(REFERENCE_PERSIAN_YEAR, REFERENCE_PERSIAN_MONTH, REFERENCE_PERSIAN_DAY);
    if (!refGregorianArray || refGregorianArray.length !== 3) throw new Error("jalaliToGregorian returned invalid data.");
    REFERENCE_DATE_GREGORIAN = new Date(Date.UTC(refGregorianArray[0], refGregorianArray[1] - 1, refGregorianArray[2]));
    REFERENCE_DATE_GREGORIAN.setUTCHours(0, 0, 0, 0);
    if (isNaN(REFERENCE_DATE_GREGORIAN.getTime())) throw new Error("Calculated Gregorian reference date is invalid.");
    console.log(`Reference Gregorian Date (UTC): ${REFERENCE_DATE_GREGORIAN.toISOString()} for Persian ${REFERENCE_PERSIAN_YEAR}/${REFERENCE_PERSIAN_MONTH}/${REFERENCE_PERSIAN_DAY} (${REFERENCE_STATUS})`);
} catch (e) {
    console.error(`CRITICAL ERROR: Failed to calculate reference Gregorian date: ${e.stack}`);
    // Attempt to notify admin, but don't let it block startup
    sendMessage(ADMIN_CHAT_ID, `🆘 CRITICAL INIT ERROR: Failed to calculate reference Gregorian date: ${e.message}`).catch(err => console.error("Failed to send admin notification on startup date error:", err));
    throw new Error(`Failed to initialize reference date. Bot cannot function. Error: ${e.message}`);
}
// --- Font Cache ---
let vazirFontArrayBuffer = null;
// --- Utility Functions ---
// PDF Specific Text Utility: Basic "reshaping" for Persian text (simple reversal)
// IMPORTANT: This is a placeholder for true text shaping. It reverses strings
// and will not correctly handle complex scripts, ligatures, or mixed LTR/RTL within a word.
// It's intended to fix text that appears completely backwards (e.g. "م ا ل س" instead of "سلام").
function reshapePersianText(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return text; // Return as is if not a non-empty string
    }
    const persianRegex = /[\u0600-\u06FF]/;
    if (!persianRegex.test(text)) {
        return text; // If no Persian characters, return as is (e.g., "-")
    }
    // For simple strings that are entirely Persian and appear backwards,
    // a simple character reversal can make them visually correct in order.
    // This will break if the string contains LTR segments like numbers or English words.
    // Example: "درس 123" becomes "321 سرد", which is incorrect.
    // This function assumes the input 'text' is predominantly a Persian segment
    // that needs its character order reversed for display in the PDF.
    return text.split('').reverse().join('');
}

function isValidPersianDate(year, month, day) {
    try {
        if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
        if (year < 1300 || year > 1500 || month < 1 || month > 12 || day < 1) return false;
        if (month <= 6 && day > 31) return false;
        if (month >= 7 && month <= 11 && day > 30) return false;
        if (month == 12) {
            const rem = year % 33;
            const isLeapYear = [1, 5, 9, 13, 17, 22, 26, 30].includes(rem);
            if (day > (isLeapYear ? 30 : 29)) return false;
        }
        return true;
    } catch (e) {
        console.error(`Error in isValidPersianDate: ${e}`);
        return false;
    }
}
function parsePersianDate(dateStr) {
    try {
        if (!dateStr) return null;
        dateStr = String(dateStr).trim();
        const persianArabicDigits = /[۰-۹٠-٩]/g;
        const digitMap = {
            '۰': 0, '۱': 1, '۲': 2, '۳': 3, '۴': 4, '۵': 5, '۶': 6, '۷': 7, '۸': 8, '۹': 9,
            '٠': 0, '١': 1, '٢': 2, '٣': 3, '٤': 4, '٥': 5, '٦': 6, '٧': 7, '٨': 8, '٩': 9
        };
        dateStr = dateStr.replace(persianArabicDigits, d => digitMap[d]);
        dateStr = dateStr.replace(/[^\d\/\-\.]/g, ''); // Keep only digits and separators
        let parts = [];
        if (dateStr.includes('/')) parts = dateStr.split('/');
        else if (dateStr.includes('-')) parts = dateStr.split('-');
        else if (dateStr.includes('.')) parts = dateStr.split('.');
        else if (dateStr.length === 8 && /^\d{8}$/.test(dateStr)) {
            parts = [dateStr.substring(0, 4), dateStr.substring(4, 6), dateStr.substring(6, 8)];
        }
        else if (dateStr.length === 6 && /^\d{6}$/.test(dateStr)) {
            parts = ["14" + dateStr.substring(0, 2), dateStr.substring(2, 4), dateStr.substring(4, 6)];
        }
        else return null;
        if (parts.length !== 3) return null;
        let p1 = parseInt(parts[0], 10);
        let p2 = parseInt(parts[1], 10);
        let p3 = parseInt(parts[2], 10);
        if (isNaN(p1) || isNaN(p2) || isNaN(p3)) return null;
        let year, month, day;
        // YYYY/MM/DD
        if (p1 >= 1300 && p1 <= 1500 && p2 >= 1 && p2 <= 12 && p3 >= 1 && p3 <= 31) {
            year = p1; month = p2; day = p3;
        }
        // DD/MM/YYYY
        else if (p3 >= 1300 && p3 <= 1500 && p2 >= 1 && p2 <= 12 && p1 >= 1 && p1 <= 31) {
            year = p3; month = p2; day = p1;
        }
        // YYYY/DD/MM
        else if (p1 >= 1300 && p1 <= 1500 && p3 >= 1 && p3 <= 12 && p2 >= 1 && p2 <= 31) {
            year = p1; month = p3; day = p2;
        }
        // YY/MM/DD (Assume 14YY)
        else if (p1 >= 0 && p1 <= 99 && p2 >= 1 && p2 <= 12 && p3 >= 1 && p3 <= 31) {
            year = 1400 + p1; month = p2; day = p3;
        }
        else return null;
        if (!isValidPersianDate(year, month, day)) return null;
        return { year, month, day };
    } catch (e) {
        console.error(`Date parse exception: ${e}`);
        return null;
    }
}
function getPersianMonthName(monthNumber) {
    const persianMonths = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
    monthNumber = parseInt(monthNumber);
    return (monthNumber >= 1 && monthNumber <= 12) ? persianMonths[monthNumber - 1] : "نامعتبر";
}
function jalaliToGregorian(jy, jm, jd) {
  try {
    jy = parseInt(jy);
    jm = parseInt(jm);
    jd = parseInt(jd);
    if (isNaN(jy) || isNaN(jm) || isNaN(jd)) {
      throw new Error("Invalid input to jalaliToGregorian");
    }
    let gy = jy <= 979 ? 621 : 1600;
    jy -= jy <= 979 ? 0 : 979;
    let days =
      365 * jy +
      Math.floor(jy / 33) * 8 +
      Math.floor(((jy % 33) + 3) / 4) +
      78 +
      jd +
      (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
    gy += 400 * Math.floor(days / 146097);
    days %= 146097;
    if (days > 36524) {
      gy += 100 * Math.floor(--days / 36524);
      days %= 36524;
      if (days >= 365) days++;
    }
    gy += 4 * Math.floor(days / 1461);
    days %= 1461;
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
    let gd = days + 1;
    const sal_a = [
      0,
      31,
      (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0 ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ];
    let gm;
    for (gm = 0; gm < 13 && gd > sal_a[gm]; gm++) gd -= sal_a[gm];
    return [gy, gm, gd];
  } catch (e) {
    console.error(`Error in jalaliToGregorian(${jy},${jm},${jd}): ${e}`);
    return null;
  }
}
// Function to get start of Persian week (Saturday) UTC
function getStartOfWeekPersian(date) {
    const targetDate = new Date(date.getTime());
    const dayOfWeekUTC = targetDate.getUTCDay(); // Sunday = 0, Saturday = 6
    const daysToSubtract = (dayOfWeekUTC + 1) % 7;
    targetDate.setUTCDate(targetDate.getUTCDate() - daysToSubtract);
    targetDate.setUTCHours(0, 0, 0, 0);
    return targetDate;
}
function getPersianDate() {
    try {
        const now = DateTime.now().setZone(TEHRAN_TIMEZONE);
        // Ensure correct locale for numbers and day/month names
        const weekday = now.setLocale("fa-IR").toLocaleString({ weekday: "long" });
        const day = now.setLocale("fa-IR-u-nu-latn").toLocaleString({ day: "numeric" }); // Use Latin numerals for day
        const month = now.setLocale("fa-IR").toLocaleString({ month: "long" });
        const year = now.setLocale("fa-IR-u-nu-latn").toLocaleString({ year: "numeric" }); // Use Latin numerals for year
        if (!weekday || !day || !month || !year) {
            throw new Error("One or more Persian date components could not be retrieved.");
        }
        return `📅 امروز ${weekday} ${day} ${month} سال ${year} است`;
    } catch (e) {
        console.error(`[Util] Error generating Persian date: ${e.stack}`);
        const fallbackDate = DateTime.now().setZone(TEHRAN_TIMEZONE).toLocaleString(DateTime.DATE_FULL, { locale: "en-US" });
        return `📅 Date (Gregorian): ${fallbackDate} (Error displaying Persian date)`;
    }
}
function getWeekStatus() {
    try {
        if (!REFERENCE_DATE_GREGORIAN || isNaN(REFERENCE_DATE_GREGORIAN.getTime())) {
            console.error("CRITICAL ERROR: REFERENCE_DATE_GREGORIAN is not valid in getWeekStatus.");
            return "نامشخص (خطای تنظیمات)";
        }
        const now = DateTime.now().setZone(TEHRAN_TIMEZONE);
        // console.log(`[WeekStatus] Current Tehran time: ${now.toISO()}`);
        
        const todayTehranAsUTC = new Date(Date.UTC(
            now.year,
            now.month - 1, 
            now.day
        ));
        todayTehranAsUTC.setUTCHours(0, 0, 0, 0);
        // console.log(`[WeekStatus] Today Tehran as UTC: ${todayTehranAsUTC.toISOString()}`);
        const currentWeekStartDate = getStartOfWeekPersian(todayTehranAsUTC);
        const referenceWeekStartDate = getStartOfWeekPersian(REFERENCE_DATE_GREGORIAN);
        // console.log(`[WeekStatus] Current week start (UTC): ${currentWeekStartDate.toISOString()}`);
        // console.log(`[WeekStatus] Reference week start (UTC): ${referenceWeekStartDate.toISOString()}`);
        if (isNaN(currentWeekStartDate.getTime()) || isNaN(referenceWeekStartDate.getTime())) {
            console.error(`Error: Invalid date calculation. CurrentStart: ${currentWeekStartDate}, ReferenceStart: ${referenceWeekStartDate}`);
            return "نامشخص (خطای محاسبه تاریخ)";
        }
        const timeDifference = currentWeekStartDate.getTime() - referenceWeekStartDate.getTime();
        const daysDifference = Math.floor(timeDifference / MS_PER_DAY);
        const weeksPassed = Math.floor(daysDifference / 7);
        const currentStatus = weeksPassed % 2 === 0 
            ? REFERENCE_STATUS 
            : REFERENCE_STATUS === "زوج" ? "فرد" : "زوج";
        // console.log(`[WeekStatus] Reference: ${REFERENCE_STATUS}, WeeksPassed: ${weeksPassed}, Result: ${currentStatus}`);
        
        return currentStatus;
    } catch (e) {
        console.error(`[WeekStatus] Error in getWeekStatus: ${e.stack}`);
        return "نامشخص (خطا)";
    }
}
async function getVazirFont() {
    if (vazirFontArrayBuffer) return vazirFontArrayBuffer;
    try {
        console.log("[PDF] Fetching Vazir font...");
        const fontUrl = "https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/fonts/ttf/Vazirmatn-Regular.ttf";
        const fontResponse = await fetch(fontUrl, {
            headers: { 'Accept': 'application/octet-stream' }
        });
        if (!fontResponse.ok) {
            throw new Error(`Failed to fetch Vazir font TTF (${fontResponse.status}): ${await fontResponse.text()}`);
        }
        vazirFontArrayBuffer = await fontResponse.arrayBuffer();
        if (!vazirFontArrayBuffer || vazirFontArrayBuffer.byteLength === 0) {
            throw new Error("Received empty font data");
        }
        console.log(`[PDF] Vazir font fetched successfully (${vazirFontArrayBuffer.byteLength} bytes)`);
        return vazirFontArrayBuffer;
    } catch (e) {
        console.error(`[PDF] Error fetching Vazir font: ${e.stack}`);
        await sendMessage(ADMIN_CHAT_ID, `⚠️ Critical Error: Failed to fetch Vazir font for PDF generation. PDFs might fail. Error: ${e.message}`).catch(ne => console.error("Failed admin notify", ne));
        return null; 
    }
}
function parseTime(timeStr) {
    if (!timeStr || !SCHEDULE_TIME_REGEX.test(timeStr)) {
        console.warn(`[Util] Invalid time format for parsing: ${timeStr}`);
        return null;
    }
    try {
        const parts = timeStr.split(":");
        const hours = parseInt(parts[0], 10);
        const minutes = parseInt(parts[1], 10);
        if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
            console.warn(`[Util] Invalid time values after parsing: ${timeStr}`);
            return null;
        }
        return hours * 60 + minutes;
    } catch (e) {
        console.error(`[Util] Error parsing time string ${timeStr}:`, e);
        return null;
    }
}
function formatDuration(totalMinutes) {
    if (totalMinutes <= 0) return "-";
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    let result = [];
    if (hours > 0) result.push(`${hours} ساعت`);
    if (minutes > 0) result.push(`${minutes} دقیقه`);
    return result.join(" و ") || "-"; 
}
function calculateIdleTime(prevLesson, currLesson) {
    try {
        const prevEnd = parseTime(prevLesson?.end_time);
        const currStart = parseTime(currLesson?.start_time);
        if (prevEnd === null || currStart === null || prevEnd >= currStart) return "-";
        let idleMinutes = 0;
        if (prevEnd < LUNCH_END_MINUTES && currStart > LUNCH_START_MINUTES) {
            const idleBeforeLunch = Math.max(0, LUNCH_START_MINUTES - prevEnd);
            const idleAfterLunch = Math.max(0, currStart - LUNCH_END_MINUTES);
            idleMinutes = idleBeforeLunch + idleAfterLunch;
        } else {
            idleMinutes = currStart - prevEnd;
        }
        return idleMinutes > 0 ? formatDuration(idleMinutes) : "-";
    } catch (e) {
        console.error("[Util] Error calculating idle time:", e);
        return "خطا";
    }
}
// --- Telegram API Functions ---
// ... (Telegram API functions remain unchanged) ...
async function telegramApiCall(method, payload = {}) {
    const url = `${TELEGRAM_URL}/${method}`;
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const responseData = await response.json();
        if (!responseData.ok) {
            console.error(`[TelegramAPI:${method}] Error: ${responseData.error_code} - ${responseData.description}. Payload: ${JSON.stringify(payload)}`);
        }
        return responseData;
    } catch (error) {
        console.error(`[TelegramAPI:${method}] Network/Fetch Error: ${error.message}`);
        return { ok: false, description: `Network/Fetch Error: ${error.message}` };
    }
}
async function sendMessage(chatId, text, replyMarkup = null, replyToMessageId = null) {
    const payload = {
        chat_id: String(chatId),
        text: text,
        parse_mode: "Markdown",
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
    return await telegramApiCall("sendMessage", payload);
}
async function editMessageText(chatId, messageId, text, replyMarkup = null) {
    const payload = {
        chat_id: String(chatId),
        message_id: messageId,
        text: text,
        parse_mode: "Markdown",
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const response = await telegramApiCall("editMessageText", payload);
    if (!response.ok && !response.description?.includes("message is not modified")) {
       // Error already logged in telegramApiCall
    }
    return response;
}
async function answerCallbackQuery(queryId, text = "", showAlert = false) {
    const payload = {
        callback_query_id: queryId,
        text: text ? text.substring(0, 200) : undefined,
        show_alert: showAlert,
    };
    const response = await telegramApiCall("answerCallbackQuery", payload);
    if (!response.ok && !response.description?.includes("query is too old") && !response.description?.includes("QUERY_ID_INVALID")) {
       // Error logged in telegramApiCall
    }
    return response;
}
async function sendDocument(chatId, documentBuffer, filename, caption = null, replyMarkup = null) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([documentBuffer], { type: "application/pdf" }), filename);
  if (caption) form.append("caption", caption);
  if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
  try {
    const response = await fetch(`${TELEGRAM_URL}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const responseData = await response.json();
    if (!responseData.ok) {
      console.error(`[sendDocument] Error to ${chatId}: ${responseData.description}`);
    }
    return responseData;
  } catch (e) {
    console.error(`[sendDocument] Network/Fetch error to ${chatId}: ${e.stack}`);
    return { ok: false, description: `Network/Fetch Error: ${e.message}` };
  }
}
async function forwardMessage(toChatId, fromChatId, messageId) {
    const payload = {
        chat_id: String(toChatId),
        from_chat_id: String(fromChatId),
        message_id: messageId,
        disable_notification: true, 
    };
    return await telegramApiCall("forwardMessage", payload);
}
async function getBotInfo(forceUpdate = false) {
    let botInfo = (await kv.get(["botInfo"])).value;
    if (!botInfo || forceUpdate) {
        console.log("[Startup/Info] Fetching bot info from Telegram API...");
        const responseData = await telegramApiCall("getMe");
        if (responseData.ok && responseData.result) {
            botInfo = {
                id: responseData.result.id.toString(),
                username: responseData.result.username || "UnknownBot",
                first_name: responseData.result.first_name,
            };
            await kv.set(["botInfo"], botInfo);
            console.log(`[Startup/Info] Bot info fetched and saved: ID=${botInfo.id}, Username=${botInfo.username}`);
        } else {
            console.error("[Startup/Info] Error fetching bot info:", responseData);
            botInfo = (await kv.get(["botInfo"])).value || { id: null, username: "this_bot", first_name:"Bot" };
            if(!botInfo.id) await sendMessage(ADMIN_CHAT_ID, `[Startup] Error fetching bot ID: ${responseData.description}`).catch(ne=>console.error("Failed admin notify", ne));
        }
    }
    return botInfo;
}
// --- Supabase Interaction Functions ---
// ... (Supabase functions remain unchanged) ...
async function logUsage(user, chat, command) {
    if (!user || !chat) {
        console.warn("[Log] Skipping usage log due to missing user or chat info.");
        return;
    }
    try {
        const payload = {
            user_id: user.id,
            first_name: user.first_name?.substring(0, 255), 
            last_name: user.last_name?.substring(0, 255),
            username: user.username?.substring(0, 255),
            command: command?.substring(0, 255) || "unknown_action",
            chat_type: chat.type?.substring(0, 50),
            chat_id: chat.id,
            chat_title: (chat.title || "").substring(0, 255),
        };
        supabase.from("bot_usage").insert(payload).then(({ error }) => {
            if (error) console.error(`[Log] Supabase usage log error for user ${user.id}: ${error.message} - Payload: ${JSON.stringify(payload)}`);
        });
    } catch (e) {
        console.error(`[Log] Exception preparing usage log: ${e.stack}`);
    }
}
async function addUser(user, chat) { 
    if (!user || !user.id || !chat || !chat.id) {
        console.error(`[Data] Invalid user or chat object in addUser`);
        return { success: false, error: "Invalid user or chat data" };
    }
    try {
        const fullName = `${user.first_name || ""} ${user.last_name || ""}`.trim() || "کاربر تلگرام";
        const { error } = await supabase.from("users").upsert({
            user_id: user.id,
            chat_id: chat.id, 
            full_name: fullName.substring(0, 255),
            username: user.username?.substring(0, 255),
            last_seen_at: new Date().toISOString(),
        }, { onConflict: "user_id" }); 
        if (error) {
            if (error.code === '23505' && error.details?.includes('chat_id')) {
                console.warn(`[Data] Chat ID ${chat.id} already exists for a different user. Ignoring upsert for user ${user.id}.`);
                return { success: true, warning: "Chat ID conflict ignored" }; 
            } else {
                console.error(`[Data] Error upserting user ${user.id} / chat ${chat.id}: ${error.message}`);
                return { success: false, error: error.message };
            }
        }
        console.log(`[Data] User ${user.id} (${fullName}) added/updated.`);
        return { success: true };
    } catch (e) {
        console.error(`[Data] Exception in addUser for ${user.id}: ${e.stack}`);
        return { success: false, error: e.message };
    }
}
async function addGroup(chat) {
    if (!chat || !chat.id || (chat.type !== "group" && chat.type !== "supergroup")) return;
    try {
        const { error } = await supabase.from("groups").upsert({
            group_id: chat.id,
            group_name: (chat.title || `گروه ${chat.id}`).substring(0, 255),
            last_seen_at: new Date().toISOString(),
        }, { onConflict: "group_id" });
        if (error) {
            console.error(`[Data] Error upserting group ${chat.id}: ${error.message}`);
        } else {
            console.log(`[Data] Group ${chat.title || chat.id} added/updated.`);
        }
    } catch (e) {
        console.error(`[Data] Exception in addGroup for ${chat.id}: ${e.stack}`);
    }
}
async function getUserSchedule(userId) {
    try {
        const { data, error } = await supabase
            .from("user_schedules")
            .select("odd_week_schedule, even_week_schedule")
            .eq("user_id", userId)
            .maybeSingle();
        if (error) throw error;
        const oddSchedule = (data?.odd_week_schedule && typeof data.odd_week_schedule === 'object' && !Array.isArray(data.odd_week_schedule))
                            ? data.odd_week_schedule : {};
        const evenSchedule = (data?.even_week_schedule && typeof data.even_week_schedule === 'object' && !Array.isArray(data.even_week_schedule))
                            ? data.even_week_schedule : {};
        const cleanSchedule = (schedule) => {
             const cleaned = {};
             for (const day of ENGLISH_WEEKDAYS) {
                 if(Array.isArray(schedule[day])) {
                     cleaned[day] = schedule[day].filter(lesson =>
                         lesson && typeof lesson.lesson === 'string' &&
                         typeof lesson.start_time === 'string' && SCHEDULE_TIME_REGEX.test(lesson.start_time) &&
                         typeof lesson.end_time === 'string' && SCHEDULE_TIME_REGEX.test(lesson.end_time) &&
                         typeof lesson.location === 'string'
                     ).sort((a, b) => (parseTime(a.start_time) ?? 9999) - (parseTime(b.start_time) ?? 9999));
                 } else {
                    cleaned[day] = []; // Ensure day exists as an empty array if no lessons
                 }
             }
             return cleaned;
        };
        return {
            odd_week_schedule: cleanSchedule(oddSchedule),
            even_week_schedule: cleanSchedule(evenSchedule)
        };
    } catch (e) {
        console.error(`[Schedule] Error fetching schedule for user ${userId}: ${e.stack}`);
        await sendMessage(ADMIN_CHAT_ID, `🆘 DB Error fetching schedule for user ${userId}: ${e.message}`);
        return { odd_week_schedule: {}, even_week_schedule: {} }; 
    }
}
async function saveUserSchedule(userId, weekType, day, lesson) {
    try {
        const currentSchedules = await getUserSchedule(userId); 
        const scheduleField = weekType === "odd" ? "odd_week_schedule" : "even_week_schedule";
        const daySchedule = currentSchedules[scheduleField]?.[day] || [];
        const updatedDaySchedule = [...daySchedule, lesson];
        updatedDaySchedule.sort((a, b) => (parseTime(a.start_time) ?? 9999) - (parseTime(b.start_time) ?? 9999));
        const finalWeekSchedule = {
            ...(currentSchedules[scheduleField] || {}),
            [day]: updatedDaySchedule 
        };
        const updatePayload = {
            user_id: userId,
            [scheduleField]: finalWeekSchedule,
            [weekType === "odd" ? "even_week_schedule" : "odd_week_schedule"]: currentSchedules[weekType === "odd" ? "even_week_schedule" : "odd_week_schedule"],
            updated_at: new Date().toISOString(),
        };
        const { error } = await supabase
            .from("user_schedules")
            .upsert(updatePayload, { onConflict: "user_id" });
        if (error) throw error;
        console.log(`[Schedule] Saved lesson for user ${userId}, week ${weekType}, day ${day}`);
    } catch (e) {
        console.error(`[Schedule] Error saving schedule for user ${userId}: ${e.stack}`);
        throw e; 
    }
}
async function deleteUserScheduleLesson(userId, weekType, day, lessonIndex) {
    try {
        const currentSchedules = await getUserSchedule(userId);
        const scheduleField = weekType === "odd" ? "odd_week_schedule" : "even_week_schedule";
        if (!currentSchedules[scheduleField]?.[day] || !currentSchedules[scheduleField][day][lessonIndex]) {
            console.warn(`[Schedule] Lesson index ${lessonIndex} not found for deletion: user ${userId}, week ${weekType}, day ${day}`);
            return false; 
        }
        const updatedDaySchedule = [...currentSchedules[scheduleField][day]];
        const deletedLesson = updatedDaySchedule.splice(lessonIndex, 1)[0]; 
        const finalWeekSchedule = {
            ...currentSchedules[scheduleField],
            [day]: updatedDaySchedule 
        };
        if (updatedDaySchedule.length === 0) {
            delete finalWeekSchedule[day];
        }
        const { error } = await supabase
            .from("user_schedules")
            .update({
                [scheduleField]: finalWeekSchedule,
                updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);
        if (error) throw error;
        console.log(`[Schedule] Lesson '${deletedLesson.lesson}' deleted for user ${userId}, week ${weekType}, day ${day}`);
        return true; 
    } catch (e) {
        console.error(`[Schedule] Error deleting schedule lesson for user ${userId}: ${e.stack}`);
        throw e; 
    }
}
async function deleteUserScheduleDay(userId, weekType, day) {
    try {
        const currentSchedules = await getUserSchedule(userId);
        const scheduleField = weekType === "odd" ? "odd_week_schedule" : "even_week_schedule";
        if (!currentSchedules[scheduleField]?.[day]) {
            console.log(`[Schedule] No lessons found to delete for user ${userId}, week ${weekType}, day ${day}`);
            return false; 
        }
        const finalWeekSchedule = { ...currentSchedules[scheduleField] };
        delete finalWeekSchedule[day];
        const { error } = await supabase
            .from("user_schedules")
            .update({
                [scheduleField]: finalWeekSchedule,
                updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);
        if (error) throw error;
        console.log(`[Schedule] All lessons deleted for user ${userId}, week ${weekType}, day ${day}`);
        return true;
    } catch (e) {
        console.error(`[Schedule] Error deleting schedule day for user ${userId}: ${e.stack}`);
        throw e;
    }
}
async function deleteEntireWeekSchedule(userId, weekType) {
    try {
        const scheduleField = weekType === "odd" ? "odd_week_schedule" : "even_week_schedule";
        const { error } = await supabase
            .from("user_schedules")
            .update({
                [scheduleField]: {}, 
                updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);
        if (error) throw error;
        console.log(`[Schedule] Entire ${weekType} week schedule deleted for user ${userId}`);
        return true;
    } catch (e) {
        console.error(`[Schedule] Error deleting entire ${weekType} schedule for user ${userId}: ${e.stack}`);
        throw e;
    }
}
// --- PDF Generation (Fixed) ---
async function generateSchedulePDF(userId, fullName) {
    console.log(`[PDF] Generating schedule PDF for user ${userId} (${fullName})`);
    try {
        const doc = new jsPDF({ 
            orientation: "landscape", 
            unit: "mm", 
            format: "a4",
            putOnlyUsedFonts: true,
            floatPrecision: 16
        });
        const schedule = await getUserSchedule(userId);
        const fontArrayBuffer = await getVazirFont();
        if (!fontArrayBuffer) {
            throw new Error("Failed to load Vazir font for PDF.");
        }
        
        const base64Font = encodeBase64(fontArrayBuffer); // Use Deno std for base64 encoding
        doc.addFileToVFS('Vazirmatn-Regular.ttf', base64Font);
        doc.addFont('Vazirmatn-Regular.ttf', 'Vazir', 'normal');
        doc.setFont('Vazir');
        doc.setR2L(true); // Enable RTL mode for the document
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const margin = 10;
        // Define logical titles (will be reshaped)
        const pdfTitle = "برنامه هفتگی";
        const nameLabel = "نام: ";
        const weekLabelPrefix = "هفته ";
        const weekTypes = [
            { type: "odd", label: "فرد", emoji: "🟣", data: schedule.odd_week_schedule },
            { type: "even", label: "زوج", emoji: "🟢", data: schedule.even_week_schedule }
        ];
        for (let pageIndex = 0; pageIndex < weekTypes.length; pageIndex++) {
            if (pageIndex > 0) {
                doc.addPage();
            }
            doc.setFont('Vazir'); // Ensure font is set for each page
            doc.setR2L(true);     // Ensure RTL is set for each page
            const { label, emoji, data } = weekTypes[pageIndex];
            // Add title and name (reshaped)
            doc.setFontSize(16);
            doc.text(reshapePersianText(pdfTitle), pageWidth / 2, 15, { align: "center" });
            doc.setFontSize(14);
            // Handle mixed LTR/RTL for name: Reshape Persian part, append LTR part
            const persianNameLabel = reshapePersianText(nameLabel);
            const isFullNamePersian = /[\u0600-\u06FF]/.test(fullName);
            const displayName = isFullNamePersian ? reshapePersianText(fullName) : fullName;
            doc.text(persianNameLabel + displayName, pageWidth / 2, 25, { align: "center" });
            doc.text(reshapePersianText(weekLabelPrefix + label) + ` ${emoji}`, pageWidth / 2, 35, { align: "center" });

            // Logical headers (rightmost column first)
            // Time strings will have LRM to enforce LTR rendering
            const logicalHeaders = [
                reshapePersianText('روز'),
                reshapePersianText('کلاس اول') + '\n' + LRM + '08:00 - 10:00' + LRM,
                reshapePersianText('کلاس دوم') + '\n' + LRM + '10:00 - 12:00' + LRM,
                reshapePersianText('کلاس سوم') + '\n' + LRM + '13:00 - 15:00' + LRM,
                reshapePersianText('کلاس چهارم') + '\n' + LRM + '15:00 - 17:00' + LRM,
                reshapePersianText('کلاس پنجم') + '\n' + LRM + '17:00 - 19:00' + LRM
            ];
            // Reverse headers for jspdf-autotable if it lays out LTR by default
            const tableHeadersForAutoTable = [...logicalHeaders].reverse();
            const tableData = [];
            for (const dayKey of ENGLISH_WEEKDAYS) {
                const lessonsForDay = data[dayKey] || [];
                // Start with day name (rightmost logical column), then placeholders
                const logicalRowCells = [
                    reshapePersianText(PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(dayKey)]),
                    reshapePersianText('-'), // Placeholder for Class 1
                    reshapePersianText('-'), // Placeholder for Class 2
                    reshapePersianText('-'), // Placeholder for Class 3
                    reshapePersianText('-'), // Placeholder for Class 4
                    reshapePersianText('-')  // Placeholder for Class 5
                ];
                for (const lesson of lessonsForDay) {
                    const startTime = lesson.start_time;
                    let slotIndex = -1; // This will be the 1-based index in logicalRowCells (after day name)
                    
                    if (startTime >= '08:00' && startTime < '10:00') slotIndex = 1;
                    else if (startTime >= '10:00' && startTime < '12:00') slotIndex = 2;
                    else if (startTime >= '13:00' && startTime < '15:00') slotIndex = 3;
                    else if (startTime >= '15:00' && startTime < '17:00') slotIndex = 4;
                    else if (startTime >= '17:00' && startTime < '19:00') slotIndex = 5;
                    
                    if (slotIndex !== -1) {
                        const lessonText = reshapePersianText(lesson.lesson);
                        const locationText = lesson.location ? reshapePersianText(lesson.location) : '';
                        logicalRowCells[slotIndex] = lessonText + (locationText ? '\n' + locationText : '');
                    }
                }
                // Reverse the logically ordered row for jspdf-autotable
                tableData.push([...logicalRowCells].reverse());
            }
            
            // Column styles mapped to VISUAL (LTR) order after reversal
            // If 'روز' (Day) was logically first and now visually last (e.g. 6 columns total, index 5)
            const dayColumnVisualIndex = logicalHeaders.length - 1;
            const classColumnVisualIndices = Array.from({length: 5}, (_, i) => dayColumnVisualIndex - 1 - i);
            const columnStylesConfig = {
                [dayColumnVisualIndex]: { cellWidth: 25, halign: 'right' }, // Day column (visually last)
                [classColumnVisualIndices[0]]: { cellWidth: 50, halign: 'right' }, // Class 1 (visually second to last)
                [classColumnVisualIndices[1]]: { cellWidth: 50, halign: 'right' }, // Class 2
                [classColumnVisualIndices[2]]: { cellWidth: 50, halign: 'right' }, // Class 3
                [classColumnVisualIndices[3]]: { cellWidth: 50, halign: 'right' }, // Class 4
                [classColumnVisualIndices[4]]: { cellWidth: 50, halign: 'right' }, // Class 5 (visually first)
            };

            autoTable(doc, {
                startY: 45,
                head: [tableHeadersForAutoTable], // Use reversed headers
                body: tableData,                 // Body data already contains reversed rows
                theme: 'grid',
                styles: {
                    font: 'Vazir',
                    fontSize: 10,
                    cellPadding: 2,
                    overflow: 'linebreak',
                    minCellHeight: 15,
                    halign: 'right', // Default horizontal alignment for cells (good for Persian)
                    valign: 'middle',
                    lineWidth: 0.3
                },
                headStyles: {
                    fillColor: [200, 200, 200],
                    textColor: [0, 0, 0],
                    fontSize: 11,
                    fontStyle: 'normal',
                    minCellHeight: 20,
                    halign: 'center' // Headers can be centered
                },
                columnStyles: columnStylesConfig,
                margin: { left: margin, right: margin },
                didDrawPage: function(dataHook) {
                    doc.setFontSize(8);
                    // Footer text should be LTR, align: "right" within RTL context places it on the left
                    // To place it on the visual right (near left margin for LTR page):
                    // doc.text("@WeekStatusBot", margin, pageHeight - 5, { align: "left" });
                    // To place it on the visual left (near right margin for LTR page / true right for RTL page context):
                    doc.text("@WeekStatusBot", pageWidth - margin, pageHeight - 5, { align: "right" });
                }
            });
        }
        console.log(`[PDF] Generation complete for user ${userId}. Outputting buffer.`);
        return new Uint8Array(doc.output('arraybuffer'));
    } catch (e) {
        console.error(`[PDF] Error generating PDF for user ${userId}: ${e.stack}`);
        await sendMessage(ADMIN_CHAT_ID, `🆘 PDF Generation Error for user ${userId} (${fullName}): ${e.message}`).catch(ne => console.error("Failed admin notify", ne));
        throw e; // Re-throw to be caught by the caller (e.g., callback handler)
    }
}

// --- Broadcast Function (Enhanced) ---
// ... (Broadcast function remains unchanged) ...
async function broadcastMessage(fromChatId, messageId, targetType) {
    console.log(`[Broadcast] Starting broadcast. Type: ${targetType}, Msg ID: ${messageId}, From: ${fromChatId}`);
    const targetLabel = targetType === "users" ? "کاربران" : "گروه‌ها";
    const idColumn = targetType === "users" ? "user_id" : "group_id";
    const tableName = targetType; 
    let broadcastRecordId = null;
    let targets = [];
    let totalTargets = 0;
    const startTime = Date.now();
    try {
        const { data: broadcastData, error: insertError } = await supabase
            .from("broadcasts")
            .insert({
                from_chat_id: fromChatId,
                message_id: messageId,
                target_type: targetType,
                status: 'sending', 
                started_at: new Date().toISOString(),
            })
            .select("broadcast_id")
            .single();
        if (insertError) throw insertError;
        broadcastRecordId = broadcastData.broadcast_id;
        console.log(`[Broadcast:${broadcastRecordId}] Recorded broadcast intent.`);
    } catch (e) {
        console.error(`[Broadcast] Error recording broadcast in Supabase: ${e.stack}`);
        await sendMessage(ADMIN_CHAT_ID, `خطا در ثبت رکورد اعلان: ${e.message}`);
        return { success: 0, fail: 0, report: `Failed to record broadcast: ${e.message}` };
    }
    try {
        const selectField = targetType === 'users' ? 'chat_id' : 'group_id'; 
        const { data, error, count } = await supabase
            .from(tableName)
            .select(selectField, { count: 'exact' });
        if (error) throw error;
        targets = data.map(item => item[selectField]?.toString()).filter(Boolean);
        totalTargets = count ?? targets.length; 
        console.log(`[Broadcast:${broadcastRecordId}] Fetched ${targets.length} target IDs (${totalTargets} total in table ${tableName}).`);
        if (targets.length === 0) {
            throw new Error(`Target list (${targetLabel}) is empty.`);
        }
    } catch (e) {
        console.error(`[Broadcast:${broadcastRecordId}] Error fetching ${targetLabel}: ${e.stack}`);
        const errorMsg = `خطا در دریافت لیست ${targetLabel}: ${e.message}`;
        await supabase.from("broadcasts").update({ status: 'failed', finished_at: new Date().toISOString(), details: errorMsg }).eq("broadcast_id", broadcastRecordId);
        await sendMessage(ADMIN_CHAT_ID, errorMsg);
        return { success: 0, fail: 0, report: errorMsg };
    }
    let successCount = 0, failCount = 0;
    const failedTargetsInfo = []; 
    await sendMessage(ADMIN_CHAT_ID, `⏳ شروع ارسال اعلان ${broadcastRecordId} به ${targets.length} ${targetLabel}...`);
    const BATCH_SIZE = 25; 
    const DELAY_BETWEEN_BATCHES = 1100; // ms
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
        const batch = targets.slice(i, i + BATCH_SIZE);
        console.log(`[Broadcast:${broadcastRecordId}] Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(targets.length / BATCH_SIZE)} (Size: ${batch.length})`);
        const batchPromises = batch.map(targetId =>
            forwardMessage(targetId, fromChatId, messageId)
                .then(result => ({ status: 'fulfilled', targetId, result }))
                .catch(error => ({ status: 'rejected', targetId, error })) 
        );
        const results = await Promise.allSettled(batchPromises);
        results.forEach(p_result => {
             if (p_result.status === 'fulfilled') {
                 const { targetId, result } = p_result.value;
                 if (result.ok) {
                     successCount++;
                 } else {
                     failCount++;
                     const errorMsg = `${result.error_code || 'Error'}: ${result.description || 'Unknown forward error'}`;
                     failedTargetsInfo.push({ targetId, error: errorMsg });
                     console.warn(`[Broadcast:${broadcastRecordId}] Failed -> ${targetType} ${targetId}: ${errorMsg}`);
                 }
             } else { 
                 const { targetId, reason } = p_result;
                 failCount++;
                 const errorMsg = reason instanceof Error ? reason.message : String(reason);
                 failedTargetsInfo.push({ targetId, error: `Network/Code Error: ${errorMsg}`});
                 console.warn(`[Broadcast:${broadcastRecordId}] Failed -> ${targetType} ${targetId}: Network/Code Error - ${errorMsg}`);
             }
         });
        if (i + BATCH_SIZE < targets.length) {
            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
        }
    }
    const duration = (Date.now() - startTime) / 1000;
    console.log(`[Broadcast:${broadcastRecordId}] Finished in ${duration.toFixed(1)}s. Success: ${successCount}, Fail: ${failCount}`);
    let reportMessage = `📢 گزارش اعلان ${broadcastRecordId} (${duration.toFixed(1)} ثانیه)\n\n`;
    reportMessage += `🎯 هدف: ${targets.length} ${targetLabel}\n`;
    reportMessage += `✅ موفق: ${successCount}\n`;
    reportMessage += `❌ ناموفق: ${failCount}\n`;
    let reportDetails = "";
    if (failCount > 0) {
        reportDetails += `\n--- خطاهای نمونه (${Math.min(failCount, 10)} مورد) ---\n`;
        failedTargetsInfo.slice(0, 10).forEach(f => {
            reportDetails += `ID: ${f.targetId}, خطا: ${f.error}\n`;
        });
        if (failCount > 10) reportDetails += `... و ${failCount - 10} خطای دیگر\n`;
    }
    const finalStatus = failCount === 0 ? 'completed' : (successCount > 0 ? 'completed_with_errors' : 'failed'); 
    try {
        await supabase.from("broadcasts").update({
            status: finalStatus,
            finished_at: new Date().toISOString(),
            success_count: successCount,
            fail_count: failCount,
            details: reportDetails.substring(0, 1000) 
        }).eq("broadcast_id", broadcastRecordId);
    } catch (e) {
        console.error(`[Broadcast:${broadcastRecordId}] Error updating final broadcast status: ${e.stack}`);
        reportMessage += "\n⚠️ خطا در بروزرسانی رکورد نهایی اعلان.";
    }
    const fullReport = reportMessage + reportDetails;
    if (fullReport.length > 4000) {
        await sendMessage(ADMIN_CHAT_ID, reportMessage + "\n...(گزارش خطاها به دلیل طول زیاد کوتاه شد)");
    } else {
        await sendMessage(ADMIN_CHAT_ID, fullReport);
    }
    return { success: successCount, fail: failCount, report: reportMessage };
}
// --- Command Handlers ---
// ... (Command Handlers remain unchanged) ...
async function handleStartCommand(message) {
    const chatId = message.chat.id;
    const user = message.from || { id: "unknown", first_name: "کاربر" };
    const chat = message.chat;
    await logUsage(user, chat, "/start");
    try {
        if (chat.type === "private") {
            await addUser(user, chat);
            const welcomeMessage = `سلام ${user.first_name}! 👋\n\nبه ربات مدیریت برنامه هفتگی و وضعیت دانشگاه خوش آمدید. 🎓\n\n*امکانات اصلی:*\n🔄 *وضعیت هفته:* نمایش زوج/فرد بودن هفته و برنامه امروز شما.\n📅 *برنامه شما:* مشاهده و مدیریت کامل برنامه هفتگی.\n⚙️ *تنظیم برنامه:* افزودن، ویرایش و حذف کلاس‌ها.\n📤 *خروجی PDF:* دریافت فایل PDF زیبا از برنامه.\n\n👇 از دکمه‌های زیر استفاده کنید:`;
            const replyMarkup = {
                inline_keyboard: [
                    [
                        { text: "🔄 وضعیت هفته و برنامه امروز", callback_data: "menu:week_status" },
                    ],
                    [
                        { text: "📅 مشاهده برنامه کامل", callback_data: "schedule:view:full" },
                        { text: "⚙️ تنظیم/ویرایش برنامه", callback_data: "menu:schedule" },
                    ],
                    [
                        { text: "📤 دریافت PDF برنامه", callback_data: "pdf:export" },
                        { text: "ℹ️ راهنما", callback_data: "menu:help" }
                    ]
                ],
            };
            await sendMessage(chatId, welcomeMessage, replyMarkup);
        } else if (chat.type === "group" || chat.type === "supergroup") {
            await addGroup(chat);
            const botInfo = await getBotInfo();
            await sendMessage(chatId, `سلام! 👋 من ربات وضعیت هفته هستم.\nبرای دیدن وضعیت از /week استفاده کنید.\nبرای تنظیم برنامه شخصی، لطفاً در چت خصوصی با من (@${botInfo.username}) صحبت کنید.`, null, message.message_id);
        }
    } catch (error) {
        console.error(`[Command:/start] Error for chat ${chatId}: ${error.stack}`);
        await sendMessage(chatId, "⚠️ متاسفانه مشکلی در اجرای دستور /start پیش آمد.");
    }
}
async function handleHelpCommand(message, fromCallback = false) {
    const chatId = message.chat.id;
    const user = message.from || { id: "unknown" };
    const chat = message.chat;
    await logUsage(user, chat, fromCallback ? "callback: menu:help" : "/help");
    try {
        const isAdmin = String(user.id) === ADMIN_CHAT_ID;
        let helpMessage = `🔰 *راهنمای ربات برنامه هفتگی* 🔰\n\n`;
        helpMessage += `*دستورات و دکمه‌ها:*\n`;
        helpMessage += `🔄 */week* یا دکمه *وضعیت هفته*: نمایش زوج/فرد بودن هفته فعلی/بعدی + برنامه امروز شما (در خصوصی).\n`;
        helpMessage += `📅 */schedule* یا دکمه *تنظیم برنامه*: ورود به منوی مدیریت برنامه (تنظیم، مشاهده، حذف).\n`;
        helpMessage += `� دکمه *دریافت PDF*: ساخت و ارسال فایل PDF برنامه شما.\n`;
        helpMessage += `🔮 */teleport <تاریخ>* : بررسی وضعیت هفته در تاریخ آینده (مثال: \`/teleport 1403/08/25\`).\n`;
        helpMessage += `ℹ️ */help* یا دکمه *راهنما*: نمایش همین پیام.\n\n`;
        if (isAdmin && chat.type === "private") {
            helpMessage += `*دستورات ادمین (فقط خصوصی):*\n`;
            helpMessage += `👑 */admin* یا دکمه *پنل مدیریت*: نمایش پنل.\n`;
            helpMessage += `📊 */stats* یا دکمه *آمار*: نمایش آمار ربات.\n\n`;
        }
        helpMessage += `*نکات:*\n`;
        helpMessage += `• ربات را می‌توانید به گروه‌های درسی اضافه کنید.\n`;
        helpMessage += `• تمام امکانات مدیریت برنامه و PDF فقط در چت خصوصی در دسترس هستند.\n`;
        helpMessage += `• تاریخ‌ها را به فرمت شمسی \`سال/ماه/روز\` وارد کنید.\n`;
        helpMessage += `• محاسبه هفته بر اساس تاریخ مرجع ${REFERENCE_PERSIAN_DAY} ${getPersianMonthName(REFERENCE_PERSIAN_MONTH)} ${REFERENCE_PERSIAN_YEAR} (هفته *${REFERENCE_STATUS}*) است.\n\n`;
        helpMessage += `ساخته شده با ❤️ توسط @alirezamozii`;
        const replyMarkup = {
            inline_keyboard: [
                [
                    { text: "🔄 وضعیت هفته و برنامه امروز", callback_data: "menu:week_status" },
                ],
                [
                    { text: "📅 مشاهده برنامه کامل", callback_data: "schedule:view:full" },
                    { text: "⚙️ تنظیم/ویرایش برنامه", callback_data: "menu:schedule" },
                ],
                [
                    { text: "📤 دریافت PDF برنامه", callback_data: "pdf:export" },
                    { text: "🔮 تلپورت", callback_data: "teleport:ask_date" }
                ],
                (isAdmin && chat.type === "private") ? [{ text: "👑 پنل مدیریت", callback_data: "admin:panel" }] : [],
            ].filter(row => row.length > 0)
        };
        if (fromCallback) {
            await editMessageText(chatId, message.message_id, helpMessage, replyMarkup);
        } else {
            await sendMessage(chatId, helpMessage, replyMarkup, message.message_id);
        }
    } catch (error) {
        console.error(`[Command:/help] Error for chat ${chatId}: ${error.stack}`);
        const errorMsg = "⚠️ خطا در نمایش راهنما.";
        if (fromCallback) await editMessageText(chatId, message.message_id, errorMsg);
        else await sendMessage(chatId, errorMsg, null, message.message_id);
    }
}
async function handleWeekCommand(message, fromCallback = false) {
    const chatId = message.chat.id;
    const user = message.from || { id: "unknown" };
    const chat = message.chat;
    await logUsage(user, chat, fromCallback ? "callback: menu:week_status" : "/week");
    try {
        const currentWeekStatus = getWeekStatus();
        const persianDate = getPersianDate();
        if (currentWeekStatus.includes("خطا") || currentWeekStatus.includes("نامشخص")) {
            const errorMsg = `❌ ${persianDate}\n\nخطا در محاسبه وضعیت هفته: ${currentWeekStatus}`;
            if (fromCallback) await editMessageText(chatId, message.message_id, errorMsg);
            else await sendMessage(chatId, errorMsg, null, message.message_id);
            return;
        }
        const currentWeekEmoji = currentWeekStatus === "زوج" ? "🟢" : "🟣";
        const nextWeekStatus = currentWeekStatus === "زوج" ? "فرد" : "زوج";
        const nextWeekEmoji = nextWeekStatus === "زوج" ? "🟢" : "🟣";
        let weekMessage = `${persianDate}\n\n`;
        weekMessage += `${currentWeekEmoji} هفته فعلی: *${currentWeekStatus}* است\n`;
        weekMessage += `${nextWeekEmoji} هفته بعدی: *${nextWeekStatus}* خواهد بود\n\n`;
        let replyMarkup = {};
        if (chat.type === "private") {
            const schedule = await getUserSchedule(user.id);
            const todayLuxon = DateTime.now().setZone(TEHRAN_TIMEZONE);
            const todayIndex = (todayLuxon.weekday + 1) % 7; 
            const todayDayKey = ENGLISH_WEEKDAYS[todayIndex]; 
            const todayPersianDay = PERSIAN_WEEKDAYS_FULL[todayIndex];
            const todaySchedule = currentWeekStatus === "زوج"
                                   ? (schedule.even_week_schedule[todayDayKey] || [])
                                   : (schedule.odd_week_schedule[todayDayKey] || []);
            if (todayIndex < 5 && todaySchedule.length > 0) { 
                weekMessage += `📅 *برنامه امروز (${todayPersianDay}):*\n\n`;
                todaySchedule.forEach((lesson, idx) => {
                    const startMins = parseTime(lesson.start_time);
                    let classNum = "";
                    if (startMins >= 8*60 && startMins < 10*60) classNum = "(کلاس اول) ";
                    else if (startMins >= 10*60 && startMins < 12*60) classNum = "(کلاس دوم) ";
                    else if (startMins >= 13*60 && startMins < 15*60) classNum = "(کلاس سوم) ";
                    else if (startMins >= 15*60 && startMins < 17*60) classNum = "(کلاس چهارم) ";
                    else if (startMins >= 17*60 && startMins < 19*60) classNum = "(کلاس پنجم) ";
                    weekMessage += `${idx + 1}. ${classNum}*${lesson.lesson}*\n`;
                    weekMessage += `   ⏰ ${lesson.start_time}-${lesson.end_time} | 📍 ${lesson.location || '-'}\n`;
                });
            } else if (todayIndex < 5) { 
                 weekMessage += `🗓️ شما برای امروز (${todayPersianDay}) در هفته *${currentWeekStatus}* برنامه‌ای تنظیم نکرده‌اید.\n`;
            } else { 
                 weekMessage += `🥳 امروز ${todayPersianDay} است! آخر هفته خوبی داشته باشید.\n`;
            }
            replyMarkup = { 
                inline_keyboard: [
                     [
                        { text: "🔄 بروزرسانی", callback_data: "menu:week_status" },
                    ],
                    [
                        { text: "📅 مشاهده برنامه کامل", callback_data: "schedule:view:full" },
                        { text: "⚙️ تنظیم/ویرایش برنامه", callback_data: "menu:schedule" },
                    ],
                     [{ text: "↩️ بازگشت به منوی اصلی", callback_data: "menu:help" }]
                ],
            };
        } else { 
            replyMarkup = {
                inline_keyboard: [
                  [{ text: "🔄 بروزرسانی وضعیت", callback_data: "menu:week_status" }],
                ],
            };
        }
        if (fromCallback) {
            await editMessageText(chatId, message.message_id, weekMessage, replyMarkup);
        } else {
            await sendMessage(chatId, weekMessage, replyMarkup, message.message_id);
        }
    } catch (error) {
        console.error(`[Command:/week] Error for chat ${chatId}: ${error.stack}`);
        const errorMsg = "⚠️ خطا در پردازش دستور /week.";
         if (fromCallback) await editMessageText(chatId, message.message_id, errorMsg);
        else await sendMessage(chatId, errorMsg, null, message.message_id);
    }
}
async function handleScheduleCommand(message, fromCallback = false) {
    const chatId = message.chat.id;
    const user = message.from || { id: "unknown" };
    const chat = message.chat;
    await logUsage(user, chat, fromCallback ? "callback: menu:schedule" : "/schedule");
    try {
        if (chat.type !== "private") {
            const botInfo = await getBotInfo();
            await sendMessage(chatId, `⚠️ مدیریت برنامه هفتگی فقط در چت خصوصی با من (@${botInfo.username}) امکان‌پذیر است.`, null, message.message_id);
            return;
        }
        await addUser(user, chat); 
        const scheduleMessage = `📅 *مدیریت برنامه هفتگی*\n\nاز دکمه‌های زیر برای تنظیم، مشاهده، حذف یا گرفتن خروجی PDF برنامه خود استفاده کنید:`;
        const replyMarkup = {
            inline_keyboard: [
                [
                    { text: "⚙️ تنظیم / افزودن درس", callback_data: "schedule:set:select_week" }, 
                    { text: "🗑️ حذف درس / روز / هفته", callback_data: "schedule:delete:main" }, 
                ],
                 [
                     { text: "📅 مشاهده برنامه کامل", callback_data: "schedule:view:full" },
                    { text: "📤 خروجی PDF برنامه", callback_data: "pdf:export" }
                ],
                [{ text: "↩️ بازگشت به منوی اصلی", callback_data: "menu:help" }], 
            ],
        };
        if (fromCallback) {
            await editMessageText(chatId, message.message_id, scheduleMessage, replyMarkup);
        } else {
            await sendMessage(chatId, scheduleMessage, replyMarkup, message.message_id);
        }
    } catch (error) {
        console.error(`[Command:/schedule] Error for chat ${chatId}: ${error.stack}`);
        const errorMsg = "⚠️ خطا در پردازش دستور /schedule.";
        if (fromCallback) await editMessageText(chatId, message.message_id, errorMsg);
        else await sendMessage(chatId, errorMsg, null, message.message_id);
    }
}
async function handleAdminCommand(message, fromCallback = false) {
    const chatId = message.chat.id;
    const user = message.from;
    const isAdmin = String(user?.id) === ADMIN_CHAT_ID;
    await logUsage(user, message.chat, fromCallback ? "callback: admin:panel" : "/admin");
    if (!isAdmin || message.chat.type !== "private") {
        await sendMessage(chatId, "⛔️ این دستور مخصوص ادمین و فقط در چت خصوصی قابل استفاده است.", null, message.message_id);
        return;
    }
    let adminMessage = `👑 *پنل مدیریت ربات*\n\n`;
    adminMessage += `وضعیت هفته فعلی: *${getWeekStatus()}*\n`;
    const replyMarkup = {
      inline_keyboard: [
        [ 
          { text: "📊 آمار ربات", callback_data: "admin:stats" },
        ],
         [ 
           { text: "↩️ بازگشت به منوی اصلی", callback_data: "menu:help" },
         ]
      ],
    };
     if (fromCallback) {
        await editMessageText(chatId, message.message_id, adminMessage, replyMarkup);
    } else {
        await sendMessage(chatId, adminMessage, replyMarkup, message.message_id);
    }
}
async function handleStatsCommand(message, fromCallback = false) {
    const chatId = message.chat.id;
    const user = message.from;
    const isAdmin = String(user?.id) === ADMIN_CHAT_ID;
    await logUsage(user, message.chat, fromCallback ? "callback: admin:stats" : "/stats");
     if (!isAdmin || message.chat.type !== "private") {
        await sendMessage(chatId, "⛔️ این دستور مخصوص ادمین و فقط در چت خصوصی قابل استفاده است.", null, message.message_id);
        return;
    }
    if (fromCallback) await answerCallbackQuery(message.callback_query_id, "📊 در حال دریافت آمار...");
    try {
        const [usersResult, groupsResult, usageResult, scheduleResult, broadcastResult] = await Promise.all([
            supabase.from("users").select('user_id', { count: 'exact', head: true }),
            supabase.from("groups").select('group_id', { count: 'exact', head: true }),
            supabase.from("bot_usage").select('*', { count: 'exact', head: true }),
            supabase.from("user_schedules").select('user_id', { count: 'exact', head: true }),
            supabase.from("broadcasts").select('broadcast_id', { count: 'exact', head: true })
        ]);
        const { data: recentCommands, error: cmdError } = await supabase
            .from("bot_usage")
            .select("command")
            .order('timestamp', { ascending: false })
            .limit(50); 
        const userCount = usersResult.count ?? 'خطا';
        const groupCount = groupsResult.count ?? 'خطا';
        const usageCount = usageResult.count ?? 'خطا';
        const scheduleCount = scheduleResult.count ?? 'خطا';
        const broadcastCount = broadcastResult.count ?? 'خطا';
        const currentStatus = getWeekStatus();
        let commandUsage = {};
        if (recentCommands && !cmdError) {
            commandUsage = recentCommands.reduce((acc, row) => {
              const cmd = row.command || 'نامشخص';
              const cleanCmd = cmd.startsWith('callback:') ? cmd.split(':')[0]+':'+cmd.split(':')[1] : cmd;
              acc[cleanCmd] = (acc[cleanCmd] || 0) + 1;
              return acc;
            }, {});
        }
        const sortedCommands = Object.entries(commandUsage)
                                    .sort(([,a], [,b]) => b - a)
                                    .slice(0, 7); 
        let statsMessage = `📊 *آمار ربات (Supabase)*\n\n`;
        statsMessage += `📅 وضعیت هفته فعلی: *${currentStatus}*\n`;
        statsMessage += `👤 کاربران ثبت شده: ${userCount}\n`;
        statsMessage += `👥 گروه‌های ثبت شده: ${groupCount}\n`;
        statsMessage += `🗓️ کاربران با برنامه: ${scheduleCount}\n`;
        statsMessage += `📢 رکوردهای اعلان: ${broadcastCount}\n`;
        statsMessage += `📈 کل استفاده ثبت شده: ${usageCount}\n\n`;
        if (sortedCommands.length > 0) {
          statsMessage += `📈 دستورات پراستفاده (نمونه ${recentCommands?.length || 0} لاگ اخیر):\n`;
          sortedCommands.forEach(([command, count]) => {
            statsMessage += ` - \`${command.substring(0, 30)}\`: ${count} بار\n`; 
          });
        } else if(cmdError) {
           statsMessage += `📈 خطا در دریافت آمار دستورات: ${cmdError.message}\n`;
        } else {
          statsMessage += "📈 اطلاعات استفاده از دستورات در دسترس نیست.\n";
        }
        const statsReplyMarkup = {
            inline_keyboard: [
              [{ text: "🔄 بروزرسانی آمار", callback_data: "admin:stats" }],
              [{ text: "↩️ بازگشت به پنل ادمین", callback_data: "admin:panel" }],
            ],
        };
        if (fromCallback) {
             await editMessageText(chatId, message.message_id, statsMessage, statsReplyMarkup);
             await answerCallbackQuery(message.callback_query_id); 
        } else {
             await sendMessage(chatId, statsMessage, statsReplyMarkup, message.message_id);
        }
    } catch (e) {
        console.error(`[Command:/stats] Error: ${e.stack}`);
         const errorMsg = "خطا در دریافت آمار از Supabase.";
         if (fromCallback) {
            await answerCallbackQuery(message.callback_query_id, errorMsg, true);
            await editMessageText(chatId, message.message_id, errorMsg, { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "admin:panel" }]] }).catch(()=>{});
         } else {
            await sendMessage(chatId, errorMsg, null, message.message_id);
         }
    }
}
async function calculateFutureWeekStatus(persianDateStr) {
    try {
        const parsedDate = parsePersianDate(persianDateStr);
        if (!parsedDate) {
            return "⚠️ تاریخ وارد شده نامعتبر است.\nفرمت: `سال/ماه/روز` (مثال: `/teleport 1404/02/10`)";
        }
        console.log(`[Teleport] Parsed Persian date: ${JSON.stringify(parsedDate)}`);
        const gregorianArray = jalaliToGregorian(parsedDate.year, parsedDate.month, parsedDate.day);
        if (!gregorianArray) {
            throw new Error("Failed to convert Persian date to Gregorian.");
        }
        const futureDateUTC = new Date(Date.UTC(gregorianArray[0], gregorianArray[1] - 1, gregorianArray[2]));
        futureDateUTC.setUTCHours(0, 0, 0, 0);
        console.log(`[Teleport] Future date UTC: ${futureDateUTC.toISOString()}`);
        if (isNaN(futureDateUTC.getTime())) {
            throw new Error("Calculated future Gregorian date is invalid.");
        }
        const now = DateTime.now().setZone(TEHRAN_TIMEZONE);
        console.log(`[Teleport] Current Tehran time: ${now.toISO()}`);
        const todayTehranAsUTC = new Date(Date.UTC(now.year, now.month - 1, now.day));
        todayTehranAsUTC.setUTCHours(0, 0, 0, 0);
        console.log(`[Teleport] Today Tehran as UTC: ${todayTehranAsUTC.toISOString()}`);
        if (futureDateUTC.getTime() < todayTehranAsUTC.getTime()) {
            return "🕰 این تاریخ در گذشته است. لطفاً تاریخی در آینده وارد کنید.";
        }
        if (!REFERENCE_DATE_GREGORIAN || isNaN(REFERENCE_DATE_GREGORIAN.getTime())) {
            console.error("CRITICAL ERROR: REFERENCE_DATE_GREGORIAN is not valid in calculateFutureWeekStatus.");
            return "❌ خطا: تنظیمات تاریخ مرجع نامعتبر است.";
        }
        const targetWeekStartDateUTC = getStartOfWeekPersian(futureDateUTC);
        const referenceWeekStartDateUTC = getStartOfWeekPersian(REFERENCE_DATE_GREGORIAN);
        console.log(`[Teleport] Target week start UTC: ${targetWeekStartDateUTC.toISOString()}`);
        console.log(`[Teleport] Reference week start UTC: ${referenceWeekStartDateUTC.toISOString()}`);
        if (isNaN(targetWeekStartDateUTC.getTime()) || isNaN(referenceWeekStartDateUTC.getTime())) {
            console.error(`Error: Invalid date calculation in future status. TargetStart: ${targetWeekStartDateUTC}, ReferenceStart: ${referenceWeekStartDateUTC}`);
            return "❌ خطا در محاسبه تاریخ هفته.";
        }
        const timeDifference = targetWeekStartDateUTC.getTime() - referenceWeekStartDateUTC.getTime();
        const daysDifferenceFromReference = Math.floor(timeDifference / MS_PER_DAY);
        const weeksPassedSinceReference = Math.floor(daysDifferenceFromReference / 7);
        
        const futureStatus = weeksPassedSinceReference % 2 === 0 
            ? REFERENCE_STATUS 
            : REFERENCE_STATUS === "زوج" ? "فرد" : "زوج";
        const futureNextWeekStatus = futureStatus === "زوج" ? "فرد" : "زوج";
        const futureStatusEmoji = futureStatus === "زوج" ? "🟢" : "🟣";
        const nextWeekStatusEmoji = futureStatus === "زوج" ? "🟣" : "🟢";
        const persianDaysOfWeek = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"];
        const persianDayIndexCorrect = (futureDateUTC.getUTCDay() + 1) % 7;
        const persianDayOfWeek = persianDaysOfWeek[persianDayIndexCorrect];
        const currentWeekStartDateUTC = getStartOfWeekPersian(todayTehranAsUTC);
        const weeksTimeDiff = targetWeekStartDateUTC.getTime() - currentWeekStartDateUTC.getTime();
        const weeksDifferenceFromToday = Math.round(weeksTimeDiff / (7 * MS_PER_DAY));
        console.log(`[Teleport] Weeks difference: ${weeksDifferenceFromToday} (${weeksTimeDiff / (7 * MS_PER_DAY)})`);
        let weeksFromTodayText = "";
        if (weeksDifferenceFromToday === 0) weeksFromTodayText = "(هفته جاری)";
        else if (weeksDifferenceFromToday === 1) weeksFromTodayText = "(هفته آینده)";
        else if (weeksDifferenceFromToday > 1) weeksFromTodayText = `(${weeksDifferenceFromToday} هفته از امروز)`;
        else if (weeksDifferenceFromToday < 0) weeksFromTodayText = `(${Math.abs(weeksDifferenceFromToday)} هفته قبل)`;
        const monthName = getPersianMonthName(parsedDate.month);
        return `🔮 نتیجه تلپورت به آینده\n📅 تاریخ: ${persianDayOfWeek} ${parsedDate.day} ${monthName} ${parsedDate.year} ${weeksFromTodayText}\n\n${futureStatusEmoji} هفته مورد نظر: هفته *${futureStatus}* خواهد بود\n${nextWeekStatusEmoji} هفته بعد آن: هفته *${futureNextWeekStatus}* خواهد بود\n\nمی‌توانید تاریخ دیگری را با دستور /teleport بررسی کنید.`;
    } catch (e) {
        console.error(`Error calculating future week status for input "${persianDateStr}": ${e.stack}`);
        return `❌ خطا در محاسبه وضعیت هفته آینده. (${e.message})`;
    }
}
async function handleTeleportCommand(message) {
     const chatId = message.chat.id;
     const text = message.text || "";
     const user = message.from || { id: "unknown" };
     await logUsage(user, message.chat, `/teleport ${text}`);
     try {
        const parts = text.split(/[\s]+/);
        let dateString = "";
        if (parts.length > 1 && parts[1]) {
            dateString = parts.slice(1).join(" ").trim();
        }
        if (!dateString) {
            await kv.set([`state:${user.id}`], JSON.stringify({ name: "awaiting_teleport_date" }), { expireIn: 5 * 60 * 1000 });
            await sendMessage(chatId, "🔮 لطفاً تاریخ شمسی مورد نظر را به فرمت `سال/ماه/روز` ارسال کنید (مثال: `1403/08/25`).", {
                inline_keyboard: [[{ text: "❌ لغو", callback_data: "cancel_action" }]]
            }, message.message_id);
        } else {
            const response = await calculateFutureWeekStatus(dateString);
            const replyMarkup = {
                inline_keyboard: [
                    [{ text: "🔮 تلپورت دوباره", callback_data: "teleport:ask_date" }],
                    [{ text: "↩️ بازگشت به منوی اصلی", callback_data: "menu:help" }],
                ],
            };
            await sendMessage(chatId, response, replyMarkup, message.message_id);
        }
     } catch (error) {
        console.error(`[Command:/teleport] Error for chat ${chatId}: ${error.stack}`);
        await sendMessage(chatId, "⚠️ خطا در پردازش دستور /teleport.", null, message.message_id);
     }
}
// --- Main Callback Query Handler ---
// ... (Callback Query Handler remains unchanged, but pdf:export will now use the fixed generateSchedulePDF) ...
async function handleCallbackQuery(query) {
    const handlerStartTime = Date.now();
    if (!query || !query.id || !query.from || !query.message) {
        console.error("[Callback] Received invalid callback query structure");
        if (query?.id) await answerCallbackQuery(query.id);
        return;
    }
    const queryId = query.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const userId = query.from.id;
    const data = query.data;
    const user = query.from; 
    const chat = query.message.chat; 
    console.log(`[Callback:${queryId}] User:${userId} Chat:${chatId} Msg:${messageId} Data: ${data}`);
    await logUsage(user, chat, `callback:${data}`); 
    const isAdmin = String(userId) === ADMIN_CHAT_ID;
    const isPrivate = chat.type === "private";
    try {
        const parts = data.split(':');
        const command = parts[0];
        const action = parts[1];
        const params = parts.slice(2); 
        if (command === 'cancel_action') {
            await kv.delete([`state:${userId}`]); 
            await editMessageText(chatId, messageId, "عملیات لغو شد.", { inline_keyboard: [[{ text: "↩️ بازگشت به منوی اصلی", callback_data: "menu:help" }]] });
            await answerCallbackQuery(queryId, "لغو شد");
            return;
        }
        if (command === 'back') {
             const prevCallbackData = params.join(':'); 
             console.log(`[Callback:${queryId}] Back action triggered. Returning to: ${prevCallbackData}`);
             query.data = prevCallbackData; 
             await handleCallbackQuery(query); 
             return;
        }
        if (command === 'menu') {
            if (action === 'help') {
                await handleHelpCommand({ ...query.message, from: user, callback_query_id: queryId }, true);
                await answerCallbackQuery(queryId);
            } else if (action === 'week_status') {
                 await handleWeekCommand({ ...query.message, from: user, callback_query_id: queryId }, true);
                await answerCallbackQuery(queryId); 
            } else if (action === 'schedule') {
                 if (!isPrivate) { await answerCallbackQuery(queryId, "فقط در چت خصوصی", true); return; }
                 await handleScheduleCommand({ ...query.message, from: user, callback_query_id: queryId }, true);
                 await answerCallbackQuery(queryId);
            }
        }
        else if (command === 'pdf' && action === 'export') {
             if (!isPrivate) { await answerCallbackQuery(queryId, "فقط در چت خصوصی", true); return; }
             await answerCallbackQuery(queryId, "⏳ در حال آماده‌سازی PDF برنامه شما...");
             try {
                 const fullName = `${user.first_name || ""} ${user.last_name || ""}`.trim() || `کاربر ${user.id}`;
                 const pdfBuffer = await generateSchedulePDF(user.id, fullName); // This now uses the fixed function
                 const fileName = `schedule_${fullName.replace(/[^a-zA-Z0-9]/g, '_')}_${user.id}.pdf`;
                 console.log(`[Callback:${queryId}] PDF generated (${(pdfBuffer.length / 1024).toFixed(1)} KB), sending: ${fileName}`);
                 await sendDocument(chatId, pdfBuffer, fileName, `📅 برنامه هفتگی شما - ${fullName}`, {
                     inline_keyboard: [
                        [{ text: "↩️ بازگشت به منوی برنامه", callback_data: "menu:schedule" }]
                    ]
                 });
             } catch (pdfError) {
                 console.error(`!!! [Callback:${queryId}] Error during PDF generation/sending:`, pdfError.stack);
                 await answerCallbackQuery(queryId, "⚠️ خطا در تولید یا ارسال PDF.", true);
                 await editMessageText(chatId, messageId, "⚠️ متاسفانه در تولید PDF خطایی رخ داد. لطفاً دوباره تلاش کنید یا با ادمین تماس بگیرید.", { 
                     inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "menu:schedule" }]] 
                 }).catch(()=>{});
             }
        }
        else if (command === 'teleport') {
            if (!isPrivate) { await answerCallbackQuery(queryId, "فقط در چت خصوصی", true); return; }
             if (action === 'ask_date') {
                await kv.set([`state:${userId}`], JSON.stringify({ name: "awaiting_teleport_date" }), { expireIn: 5 * 60 * 1000 });
                await editMessageText(chatId, messageId, "🔮 لطفاً تاریخ شمسی مورد نظر را به فرمت `سال/ماه/روز` ارسال کنید (مثال: `1403/08/25`).", {
                    inline_keyboard: [[{ text: "❌ لغو", callback_data: "cancel_action" }]]
                });
                await answerCallbackQuery(queryId, "منتظر دریافت تاریخ...");
            }
        }
        else if (command === 'schedule') {
             if (!isPrivate) { await answerCallbackQuery(queryId, "فقط در چت خصوصی", true); return; }
             await handleScheduleCallback(query, action, params); 
        }
        else if (command === 'admin') {
            if (!isAdmin || !isPrivate) { await answerCallbackQuery(queryId, "⛔️ فقط ادمین در چت خصوصی", true); return; }
            if (action === 'broadcast' && params[0] === 'confirm') { // Handle broadcast confirmation
                const originalMessageIdToBroadcast = parseInt(params[1]);
                if (isNaN(originalMessageIdToBroadcast)) {
                    await answerCallbackQuery(queryId, "خطا: شناسه پیام نامعتبر برای اعلان.", true);
                    return;
                }
                const targetType = (await kv.get<string>(["broadcastTarget"])).value || "users"; // Explicitly type value
                await kv.delete(["broadcastMode"]);
                await kv.delete(["broadcastTarget"]);
                await editMessageText(chatId, messageId, `✅ اعلان برای ${originalMessageIdToBroadcast} به ${targetType === "users" ? "کاربران" : "گروه‌ها"} در حال ارسال است...`);
                await answerCallbackQuery(queryId); // Acknowledge first
                await broadcastMessage(String(chatId), originalMessageIdToBroadcast, targetType); // Make sure fromChatId is string
            } else if (action === 'broadcast' && params[0] === 'cancel') {
                await kv.delete(["broadcastMode"]);
                await kv.delete(["broadcastTarget"]);
                await editMessageText(chatId, messageId, "ارسال اعلان لغو شد.", {inline_keyboard: [[{text: "بازگشت به پنل ادمین", callback_data: "admin:panel"}]]});
                await answerCallbackQuery(queryId, "لغو شد");
            }
            else {
                await handleAdminCallback(query, action, params); 
            }
        }
        else {
            console.warn(`[Callback:${queryId}] Unhandled callback command: ${command}`);
            await answerCallbackQuery(queryId); 
        }
        const handlerDuration = Date.now() - handlerStartTime;
        if (handlerDuration > 1500) { 
            console.warn(`[Callback:${queryId}] Slow Handler (${handlerDuration}ms) for Data: ${data}`);
        } else {
             console.log(`[Callback:${queryId}] END (${handlerDuration}ms)`);
        }
    } catch (error) {
        const handlerDuration = Date.now() - handlerStartTime;
        console.error(`!!! [Callback:${query?.id}] Top-level error processing query (took ${handlerDuration}ms), data ${query?.data} User ${query?.from?.id}:`, error.stack);
        try { await answerCallbackQuery(query?.id, "خطا در پردازش درخواست.", true); }
        catch (answerError) { console.error("!! Failed to answer callback query after error:", answerError); }
        await sendMessage(ADMIN_CHAT_ID, `🆘 Error in handleCallbackQuery for data ${query?.data} User ${query?.from?.id}: ${error.message}`).catch(ne => console.error("Failed admin notify", ne));
    }
}
async function handleScheduleCallback(query, action, params) {
    const { id: queryId, from: user, message } = query;
    const { chat: { id: chatId }, message_id: messageId } = message;
    const userId = user.id;
    await addUser(user, message.chat);
    const weekType = params[0]; 
    const day = params[1]; 
    const lessonIndex = params[2] ? parseInt(params[2]) : null;
    console.log(`[ScheduleCallback] Action: ${action}, Params: ${params}`);
    if (action === 'view' && params[0] === 'full') {
        const schedule = await getUserSchedule(userId);
        let scheduleMessage = `📅 *برنامه کامل هفتگی شما*\n\n`;
        let hasAnySchedule = false;
        const formatWeek = (type, scheduleData) => {
            const label = type === 'odd' ? 'فرد 🟣' : 'زوج 🟢';
            let weekText = `*--- هفته ${label} ---*\n`;
            let hasScheduleThisWeek = false;
            ENGLISH_WEEKDAYS.forEach((dKey, index) => {
                const lessons = scheduleData[dKey] || [];
                if (lessons.length > 0) {
                    hasScheduleThisWeek = true; hasAnySchedule = true;
                    weekText += `\n*${PERSIAN_WEEKDAYS[index]}:*\n`;
                    lessons.forEach((l, idx) => { 
                        weekText += ` ${idx + 1}. *${l.lesson}*\n    ⏰ ${l.start_time}-${l.end_time} | 📍 ${l.location || '-'}\n`;
                    });
                }
            });
            if (!hasScheduleThisWeek) weekText += "_برنامه‌ای برای این هفته تنظیم نشده است._\n";
            return weekText + "\n";
        };
        scheduleMessage += formatWeek("odd", schedule.odd_week_schedule);
        scheduleMessage += formatWeek("even", schedule.even_week_schedule);
        if (!hasAnySchedule) scheduleMessage = "📅 *برنامه هفتگی شما*\n\n_هنوز هیچ درسی برای هیچ هفته‌ای تنظیم نکرده‌اید._";
        const replyMarkup = {
             inline_keyboard: [
                [{ text: "⚙️ تنظیم / افزودن درس", callback_data: "schedule:set:select_week" }],
                [{ text: "🗑️ حذف درس / روز / هفته", callback_data: "schedule:delete:main" }],
                [{ text: "📤 خروجی PDF", callback_data: "pdf:export" }],
                [{ text: "↩️ بازگشت به منوی اصلی", callback_data: "menu:help" }]
             ]
        };
        await editMessageText(chatId, messageId, scheduleMessage, replyMarkup);
        await answerCallbackQuery(queryId);
    }
    else if (action === 'set') {
        if (params[0] === 'select_week') {
             const scheduleMessage = `📅 *تنظیم برنامه هفتگی*\n\nبرنامه کدام هفته را می‌خواهید تنظیم یا ویرایش کنید؟`;
             const replyMarkup = {
                  inline_keyboard: [
                      [{ text: "هفته فرد 🟣", callback_data: "schedule:set:select_day:odd" }, { text: "هفته زوج 🟢", callback_data: "schedule:set:select_day:even" }],
                      [{ text: "↩️ بازگشت (منو برنامه)", callback_data: "menu:schedule" }]
                    ]
             };
             await editMessageText(chatId, messageId, scheduleMessage, replyMarkup);
             await answerCallbackQuery(queryId);
        }
        else if (params[0] === 'select_day') {
             const weekType = params[1]; 
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             const dayButtons = ENGLISH_WEEKDAYS.map((dayKey, index) => ({
                text: PERSIAN_WEEKDAYS[index],
                callback_data: `schedule:set:show_day:${weekType}:${dayKey}`
             }));
             const rows = [];
             for (let i = 0; i < dayButtons.length; i += 2) {
                rows.push(dayButtons.slice(i, i + 2));
             }
             const replyMarkup = {
                  inline_keyboard: [
                      ...rows,
                      [{ text: "↩️ بازگشت (انتخاب هفته)", callback_data: "schedule:set:select_week" }]
                  ]
             };
             await editMessageText(chatId, messageId, `📅 *تنظیم برنامه هفته ${weekLabel}*\n\nلطفاً روز مورد نظر را انتخاب کنید:`, replyMarkup);
             await answerCallbackQuery(queryId);
        }
         else if (params[0] === 'show_day') {
             const weekType = params[1];
             const day = params[2];
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             const dayLabel = PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(day)];
             const schedule = await getUserSchedule(userId);
             const lessons = (weekType === "odd" ? schedule.odd_week_schedule[day] : schedule.even_week_schedule[day]) || [];
             let messageText = `🗓️ *برنامه روز ${dayLabel} - هفته ${weekLabel}*\n\n`;
             if (lessons.length === 0) {
                messageText += "_هنوز درسی برای این روز ثبت نشده است._\n";
             } else {
                 lessons.forEach((l, idx) => {
                    messageText += ` ${idx + 1}. *${l.lesson}* ( ${l.start_time} - ${l.end_time} | ${l.location || '-'} )\n`;
                 });
             }
              messageText += "\nمی‌توانید درس جدیدی اضافه کنید:";
             const replyMarkup = {
                  inline_keyboard: [
                    [{ text: "➕ افزودن درس جدید", callback_data: `schedule:set:ask_details:${weekType}:${day}` }],
                    [{ text: `↩️ بازگشت (انتخاب روز ${weekLabel})`, callback_data: `schedule:set:select_day:${weekType}` }]
                  ]
             };
             await editMessageText(chatId, messageId, messageText, replyMarkup);
             await answerCallbackQuery(queryId);
        }
        else if (params[0] === 'ask_details') {
            const weekType = params[1];
            const day = params[2];
            const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
            const dayLabel = PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(day)];
             await kv.set([`state:${userId}`], JSON.stringify({
                name: "awaiting_lesson_details",
                weekType: weekType,
                day: day
             }), { expireIn: 10 * 60 * 1000 }); 
            const messageText = `➕ *افزودن درس به ${dayLabel} (هفته ${weekLabel})*\n\n` +
                                "لطفاً اطلاعات درس را در یک پیام و با فرمت زیر ارسال کنید:\n" +
                                "`نام کامل درس` - `ساعت شروع` - `ساعت پایان` - `محل برگزاری`\n\n" +
                                "*مثال:*\n" +
                                "`برنامه سازی پیشرفته` - `8:00` - `10:00` - `کلاس 309 ابریشم چیان`\n\n" +
                                "*نکات:*\n" +
                                "• از خط تیره (-) برای جدا کردن بخش‌ها استفاده کنید.\n" +
                                "• ساعت‌ها را به فرمت `HH:MM` (مانند `13:30` یا `08:00`) وارد کنید.";
            const replyMarkup = { inline_keyboard: [[{ text: "❌ لغو و بازگشت", callback_data: `schedule:set:show_day:${weekType}:${day}` }]] };
            await editMessageText(chatId, messageId, messageText, replyMarkup);
            await answerCallbackQuery(queryId, "لطفاً اطلاعات درس را وارد کنید...");
        }
    }
    else if (action === 'delete') {
         if (params[0] === 'main') {
            const replyMarkup = {
                 inline_keyboard: [
                     [{ text: "🟣 حذف کل هفته فرد", callback_data: "schedule:delete:confirm_week:odd" }],
                     [{ text: "🟢 حذف کل هفته زوج", callback_data: "schedule:delete:confirm_week:even" }],
                     [{ text: "🗑️ حذف دروس یک روز خاص", callback_data: "schedule:delete:select_week:day" }],
                     [{ text: "❌ حذف یک درس خاص", callback_data: "schedule:delete:select_week:lesson" }],
                     [{ text: "↩️ بازگشت (منو برنامه)", callback_data: "menu:schedule" }]
                 ]
            };
            await editMessageText(chatId, messageId, "🗑️ *حذف برنامه*\n\nکدام بخش از برنامه را می‌خواهید حذف کنید؟\n*توجه:* این عملیات غیرقابل بازگشت است.", replyMarkup);
            await answerCallbackQuery(queryId);
        }
        else if (params[0] === 'confirm_week') { 
             const weekType = params[1];
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             const replyMarkup = {
                 inline_keyboard: [
                    [{ text: `✅ بله، حذف کن هفته ${weekLabel}`, callback_data: `schedule:delete:execute_week:${weekType}` }],
                    [{ text: "❌ نه، بازگشت", callback_data: "schedule:delete:main" }]
                 ]
             };
             await editMessageText(chatId, messageId, `❓ *تایید حذف کل هفته ${weekLabel}*\n\nآیا مطمئن هستید که می‌خواهید تمام دروس ثبت شده برای هفته ${weekLabel} را حذف کنید؟`, replyMarkup);
             await answerCallbackQuery(queryId);
        }
         else if (params[0] === 'execute_week') { 
             const weekType = params[1];
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             try {
                 await deleteEntireWeekSchedule(userId, weekType);
                 await editMessageText(chatId, messageId, `✅ تمام دروس هفته ${weekLabel} با موفقیت حذف شدند.`, { inline_keyboard: [[{ text: "↩️ بازگشت به منوی حذف", callback_data: "schedule:delete:main" }]] });
                 await answerCallbackQuery(queryId, `هفته ${weekLabel} حذف شد`);
             } catch (e) {
                 await editMessageText(chatId, messageId, `⚠️ خطا در حذف هفته ${weekLabel}: ${e.message}`, { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "schedule:delete:main" }]] });
                 await answerCallbackQuery(queryId, "خطا در حذف", true);
             }
         }
         else if (params[0] === 'select_week') { 
             const deleteType = params[1]; 
             const typeLabel = deleteType === 'day' ? 'روز' : 'درس';
             const nextAction = `schedule:delete:select_day:${deleteType}`;
             const replyMarkup = {
                 inline_keyboard: [
                    [{ text: "هفته فرد 🟣", callback_data: `${nextAction}:odd` }, { text: "هفته زوج 🟢", callback_data: `${nextAction}:even` }],
                    [{ text: "↩️ بازگشت (منو حذف)", callback_data: "schedule:delete:main" }]
                 ]
             };
             await editMessageText(chatId, messageId, `🗑️ *حذف ${typeLabel}*\n\nلطفاً هفته مورد نظر را انتخاب کنید:`, replyMarkup);
             await answerCallbackQuery(queryId);
         }
         else if (params[0] === 'select_day') { 
             const deleteType = params[1]; 
             const weekType = params[2]; 
             const typeLabel = deleteType === 'day' ? 'روز' : 'درس';
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             const schedule = await getUserSchedule(userId);
             const weekSchedule = weekType === 'odd' ? schedule.odd_week_schedule : schedule.even_week_schedule;
             const dayButtons = ENGLISH_WEEKDAYS
                 .filter(dayKey => weekSchedule[dayKey] && weekSchedule[dayKey].length > 0) 
                 .map((dayKey, index) => ({
                     text: PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(dayKey)], 
                     callback_data: deleteType === 'day'
                                     ? `schedule:delete:confirm_day:${weekType}:${dayKey}` 
                                     : `schedule:delete:select_lesson:${weekType}:${dayKey}` 
                 }));
             if (dayButtons.length === 0) {
                 await editMessageText(chatId, messageId, `⚠️ در هفته ${weekLabel} هیچ روزی با برنامه ثبت شده یافت نشد.`, { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: `schedule:delete:select_week:${deleteType}` }]] });
                 await answerCallbackQuery(queryId, "برنامه‌ای یافت نشد");
                 return;
             }
             const rows = []; for (let i = 0; i < dayButtons.length; i += 2) { rows.push(dayButtons.slice(i, i + 2)); }
             const replyMarkup = {
                  inline_keyboard: [
                      ...rows,
                      [{ text: "↩️ بازگشت (انتخاب هفته)", callback_data: `schedule:delete:select_week:${deleteType}` }]
                  ]
             };
             await editMessageText(chatId, messageId, `🗑️ *حذف ${typeLabel} (هفته ${weekLabel})*\n\nلطفاً روز مورد نظر را انتخاب کنید:`, replyMarkup);
             await answerCallbackQuery(queryId);
         }
          else if (params[0] === 'confirm_day') { 
             const weekType = params[1];
             const day = params[2];
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             const dayLabel = PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(day)];
             const replyMarkup = {
                 inline_keyboard: [
                    [{ text: `✅ بله، حذف کن ${dayLabel} (${weekLabel})`, callback_data: `schedule:delete:execute_day:${weekType}:${day}` }],
                    [{ text: "❌ نه، بازگشت", callback_data: `schedule:delete:select_day:day:${weekType}` }] 
                 ]
             };
             await editMessageText(chatId, messageId, `❓ *تایید حذف روز ${dayLabel} (هفته ${weekLabel})*\n\nآیا مطمئن هستید که می‌خواهید تمام دروس ثبت شده برای این روز را حذف کنید؟`, replyMarkup);
             await answerCallbackQuery(queryId);
         }
         else if (params[0] === 'execute_day') { 
             const weekType = params[1];
             const day = params[2];
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             const dayLabel = PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(day)];
             try {
                 await deleteUserScheduleDay(userId, weekType, day);
                 await editMessageText(chatId, messageId, `✅ تمام دروس روز ${dayLabel} (${weekLabel}) حذف شدند.`, { inline_keyboard: [[{ text: "↩️ بازگشت به منوی حذف", callback_data: "schedule:delete:main" }]] });
                 await answerCallbackQuery(queryId, `روز ${dayLabel} حذف شد`);
             } catch (e) {
                 await editMessageText(chatId, messageId, `⚠️ خطا در حذف روز ${dayLabel} (${weekLabel}): ${e.message}`, { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: "schedule:delete:main" }]] });
                 await answerCallbackQuery(queryId, "خطا در حذف", true);
             }
         }
         else if (params[0] === 'select_lesson') { 
             const weekType = params[1];
             const day = params[2];
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             const dayLabel = PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(day)];
             const schedule = await getUserSchedule(userId);
             const lessons = (weekType === "odd" ? schedule.odd_week_schedule[day] : schedule.even_week_schedule[day]) || [];
              if (lessons.length === 0) {
                 await editMessageText(chatId, messageId, `⚠️ در روز ${dayLabel} (${weekLabel}) درسی برای حذف یافت نشد.`, { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: `schedule:delete:select_day:lesson:${weekType}` }]] });
                 await answerCallbackQuery(queryId, "درسی یافت نشد");
                 return;
             }
             let messageText = `🗑️ *حذف درس خاص*\nروز: ${dayLabel} | هفته: ${weekLabel}\n\nکدام درس را می‌خواهید حذف کنید؟\n`;
             const lessonButtons = lessons.map((l, idx) => ([{
                text: `❌ ${idx + 1}. ${l.lesson} (${l.start_time}-${l.end_time})`,
                callback_data: `schedule:delete:confirm_lesson:${weekType}:${day}:${idx}`
             }]));
             const replyMarkup = {
                 inline_keyboard: [
                     ...lessonButtons,
                     [{ text: "↩️ بازگشت (انتخاب روز)", callback_data: `schedule:delete:select_day:lesson:${weekType}` }]
                 ]
             };
             await editMessageText(chatId, messageId, messageText, replyMarkup);
             await answerCallbackQuery(queryId);
         }
         else if (params[0] === 'confirm_lesson') { 
             const weekType = params[1];
             const day = params[2];
             const lessonIndex = parseInt(params[3]);
             const weekLabel = weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
             const dayLabel = PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(day)];
             const schedule = await getUserSchedule(userId);
             const lesson = (weekType === "odd" ? schedule.odd_week_schedule[day]?.[lessonIndex] : schedule.even_week_schedule[day]?.[lessonIndex]);
             if (!lesson) {
                await editMessageText(chatId, messageId, "⚠️ خطا: درس مورد نظر یافت نشد.", { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: `schedule:delete:select_lesson:${weekType}:${day}` }]] });
                await answerCallbackQuery(queryId, "درس یافت نشد", true);
                return;
             }
             const replyMarkup = {
                 inline_keyboard: [
                    [{ text: `✅ بله، حذف کن`, callback_data: `schedule:delete:execute_lesson:${weekType}:${day}:${lessonIndex}` }],
                    [{ text: "❌ نه، بازگشت", callback_data: `schedule:delete:select_lesson:${weekType}:${day}` }]
                 ]
             };
             await editMessageText(chatId, messageId, `❓ *تایید حذف درس*\n\nآیا مطمئن هستید می‌خواهید درس زیر را حذف کنید؟\n\n*درس:* ${lesson.lesson}\n*زمان:* ${lesson.start_time} - ${lesson.end_time}\n*روز:* ${dayLabel} (${weekLabel})`, replyMarkup);
             await answerCallbackQuery(queryId);
        }
        else if (params[0] === 'execute_lesson') { 
             const weekType = params[1];
             const day = params[2];
             const lessonIndex = parseInt(params[3]);
             try {
                 const success = await deleteUserScheduleLesson(userId, weekType, day, lessonIndex);
                 if (success) {
                     query.data = `schedule:delete:select_lesson:${weekType}:${day}`;
                     await handleCallbackQuery(query); 
                     await answerCallbackQuery(queryId, `درس حذف شد`);
                 } else {
                      await editMessageText(chatId, messageId, `⚠️ درس مورد نظر یافت نشد یا قبلاً حذف شده است.`, { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: `schedule:delete:select_lesson:${weekType}:${day}` }]] });
                      await answerCallbackQuery(queryId, "درس یافت نشد");
                 }
             } catch (e) {
                 await editMessageText(chatId, messageId, `⚠️ خطا در حذف درس: ${e.message}`, { inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: `schedule:delete:select_lesson:${weekType}:${day}` }]] });
                 await answerCallbackQuery(queryId, "خطا در حذف", true);
             }
         }
    } 
    else {
         console.warn(`[ScheduleCallback] Unhandled action: ${action} with params: ${params}`);
         await answerCallbackQuery(queryId); 
    }
}
async function handleAdminCallback(query, action, params) {
     const { id: queryId, from: user, message } = query;
     const { chat: { id: chatId }, message_id: messageId } = message;
     if (action === 'panel') {
        await handleAdminCommand({ ...message, from: user, callback_query_id: queryId }, true);
        await answerCallbackQuery(queryId);
     }
     else if (action === 'stats') {
        await handleStatsCommand({ ...message, from: user, callback_query_id: queryId }, true);
        // answerCallbackQuery is handled inside handleStatsCommand
     }
     // Note: Broadcast confirm/cancel moved to main handleCallbackQuery for clarity
     else {
        console.warn(`[AdminCallback] Unhandled admin action: ${action} with params: ${params}`);
        await answerCallbackQuery(queryId);
    }
}
// --- Main Message Handler ---
// ... (Main Message Handler remains unchanged) ...
async function handleMessage(message) {
    const handlerStartTime = Date.now();
    if (!message || !message.chat || !message.from) {
        console.warn(`[handleMessage] Ignoring message with missing info`);
        return;
    }
    const messageId = message.message_id;
    const chatId = message.chat.id;
    const user = message.from;
    const chat = message.chat;
    const text = message.text || "";
    const chatType = message.chat.type;
    const isAdmin = String(user.id) === ADMIN_CHAT_ID;
    console.log(`[handleMessage:${messageId}] START User:${user.id} Chat:${chatId} Type:${chatType}`);
    if (chatType === "group" || chatType === "supergroup") {
        const botInfo = await getBotInfo();
        if (botInfo.id && message.new_chat_members?.some(member => String(member.id) === botInfo.id)) {
            console.log(`[handleMessage:${messageId}] Bot added to group ${chatId} (${chat.title})`);
            await addGroup(chat); 
            await logUsage(user, chat, "bot_added_to_group");
            const welcomeMessage = `سلام! 👋 من ربات وضعیت هفته و برنامه درسی هستم.\nدستورات اصلی:\n/week - نمایش وضعیت هفته\n/help - راهنما\n\nبرای تنظیم برنامه شخصی، در چت خصوصی با من (@${botInfo.username}) صحبت کنید.`;
            await sendMessage(chatId, welcomeMessage);
            return;
        }
        if (botInfo.id && message.left_chat_member && String(message.left_chat_member.id) === botInfo.id) {
            console.log(`[handleMessage:${messageId}] Bot removed/left group: ${chatId} (${chat.title})`);
            await logUsage(user, chat, "bot_removed_from_group");
            return;
        }
    }
    if (user.is_bot) {
        console.log(`[handleMessage:${messageId}] Ignoring message from bot ${user.id}`);
        return;
    }
    if (chatType === "private") {
        const stateResult = await kv.get([`state:${user.id}`]);
        if (stateResult.value) {
            let state;
            try { state = JSON.parse(stateResult.value); } catch (e) { await kv.delete([`state:${user.id}`]); return; }
            console.log(`[handleMessage:${messageId}] User ${user.id} has state: ${state.name}`);
            if (state.name === "awaiting_teleport_date") {
                 await kv.delete([`state:${user.id}`]); 
                 await logUsage(user, chat, `input:teleport_date`);
                 const response = await calculateFutureWeekStatus(text); 
                 const replyMarkup = { inline_keyboard: [ [{ text: "🔮 تلپورت دوباره", callback_data: "teleport:ask_date" }], [{ text: "↩️ بازگشت به منوی اصلی", callback_data: "menu:help" }] ] };
                 await sendMessage(chatId, response, replyMarkup, messageId);
                 return;
            }
             else if (state.name === "awaiting_lesson_details") {
                 await kv.delete([`state:${user.id}`]); 
                 await logUsage(user, chat, `input:lesson_details`);
                 
                 const parts = text.split('-').map(p => p.trim());
                 if (parts.length !== 4) {
                     await sendMessage(chatId, "⚠️ فرمت وارد شده صحیح نیست. لطفاً با فرمت زیر وارد کنید:\n`نام درس` - `ساعت شروع` - `ساعت پایان` - `محل برگزاری`", {
                         inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: `schedule:set:show_day:${state.weekType}:${state.day}` }]]
                     });
                     return;
                 }
                 const [lesson, startTime, endTime, location] = parts;
                 
                 if (!SCHEDULE_TIME_REGEX.test(startTime) || !SCHEDULE_TIME_REGEX.test(endTime)) {
                     await sendMessage(chatId, "⚠️ فرمت ساعت باید به صورت `HH:MM` باشد. مثال: `08:30` یا `13:45`", {
                         inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: `schedule:set:show_day:${state.weekType}:${state.day}` }]]
                     });
                     return;
                 }
                 const startMinutes = parseTime(startTime);
                 const endMinutes = parseTime(endTime);
                 if (startMinutes == null || endMinutes == null || startMinutes >= endMinutes) { // Added null check for parseTime
                     await sendMessage(chatId, "⚠️ ساعت شروع باید قبل از ساعت پایان و معتبر باشد.", {
                         inline_keyboard: [[{ text: "↩️ بازگشت", callback_data: `schedule:set:show_day:${state.weekType}:${state.day}` }]]
                     });
                     return;
                 }
                 try {
                     await saveUserSchedule(user.id, state.weekType, state.day, {
                         lesson: lesson,
                         start_time: startTime,
                         end_time: endTime,
                         location: location
                     });
                     const weekLabel = state.weekType === "odd" ? "فرد 🟣" : "زوج 🟢";
                     const dayLabel = PERSIAN_WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(state.day)];
                     await sendMessage(chatId, `✅ درس *${lesson}* با موفقیت به برنامه روز ${dayLabel} (هفته ${weekLabel}) اضافه شد.`);
                     const schedule = await getUserSchedule(user.id);
                     const lessons = (state.weekType === "odd" ? schedule.odd_week_schedule[state.day] : schedule.even_week_schedule[state.day]) || [];
                     let messageText = `🗓️ *برنامه روز ${dayLabel} - هفته ${weekLabel}*\n\n`;
                     lessons.forEach((l, idx) => {
                         messageText += `${idx + 1}. *${l.lesson}*\n   ⏰ ${l.start_time} - ${l.end_time}\n   📍 ${l.location || '-'}\n`;
                     });
                     const replyMarkup = {
                         inline_keyboard: [
                             [{ text: "➕ افزودن درس دیگر", callback_data: `schedule:set:ask_details:${state.weekType}:${state.day}` }],
                             [{ text: "↩️ بازگشت به انتخاب روز", callback_data: `schedule:set:select_day:${state.weekType}` }],
                             [{ text: "🏠 منوی اصلی", callback_data: "menu:help" }]
                         ]
                     };
                     await sendMessage(chatId, messageText, replyMarkup);
                 } catch (e) {
                     console.error(`[Schedule] Error saving lesson for user ${user.id}:`, e.stack);
                     await sendMessage(chatId, `⚠️ خطا در ذخیره درس: ${e.message}`, {
                         inline_keyboard: [[{ text: "↩️ تلاش مجدد", callback_data: `schedule:set:show_day:${state.weekType}:${state.day}` }]]
                     });
                 }
                 return;
            }
             console.warn(`[Message] User ${user.id} had unhandled state: ${state.name}. Clearing state.`);
             await kv.delete([`state:${user.id}`]); 
        } 
        // Handle broadcast input moved to handleCallbackQuery for button confirmation
    } 
    if (text.startsWith("/")) {
        const commandStartTime = Date.now();
        const commandPart = text.split(/[\s@]/)[0].toLowerCase(); 
        const botInfo = await getBotInfo();
        if (chatType !== 'private' && text.includes("@") && botInfo.username && !text.toLowerCase().includes(`@${botInfo.username.toLowerCase()}`)) {
            console.log(`[handleMessage:${messageId}] Ignoring command ${commandPart} intended for another bot.`);
            return;
        }
        let logAction = commandPart; 
        console.log(`[handleMessage:${messageId}] Processing command: ${commandPart}`);
        try {
            switch (commandPart) {
              case "/start": await handleStartCommand(message); break;
              case "/help": await handleHelpCommand(message); break;
              case "/week": await handleWeekCommand(message); break;
              case "/schedule": await handleScheduleCommand(message); break;
              case "/admin": await handleAdminCommand(message); break;
              case "/stats": await handleStatsCommand(message); break;
              case "/teleport": await handleTeleportCommand(message); break;
              default:
                logAction = `unknown_command: ${commandPart}`;
                if (chatType === "private") {
                    await sendMessage(chatId, `❓ دستور \`${commandPart}\` را متوجه نشدم. لطفاً از /help استفاده کنید.`, null, messageId);
                } 
            }
            const commandDuration = Date.now() - commandStartTime;
            console.log(`[handleMessage:${messageId}] Command ${commandPart} processed in ${commandDuration}ms`);
        } catch (commandError) {
             logAction = `command_error: ${commandPart}`;
             console.error(`!!! [handleMessage:${messageId}] Error executing command ${commandPart}:`, commandError.stack);
             await sendMessage(ADMIN_CHAT_ID, `🆘 Error executing ${commandPart} for user ${user.id}: ${commandError.message}`).catch(ne=>console.error("Failed admin notify", ne));
             await sendMessage(chatId, "⚠️ متاسفانه در پردازش دستور شما خطایی رخ داد.", null, messageId).catch(()=>{}); 
        }
        await logUsage(user, chat, logAction);
    } else if (chatType === "private") {
        await logUsage(user, chat, "non_command_private");
        console.log(`[handleMessage:${messageId}] Non-command/state message in private chat`);
    } 
    const handlerDuration = Date.now() - handlerStartTime;
     if (handlerDuration > 2000) { 
        console.warn(`[handleMessage:${messageId}] Slow Handler (${handlerDuration}ms) for Type: ${chatType}, Text: ${text.substring(0,50)}`);
    } else {
        console.log(`[handleMessage:${messageId}] END (${handlerDuration}ms)`);
    }
}
// --- Webhook Request Handler ---
// ... (Webhook Handler remains unchanged) ...
async function handleRequest(request) {
    const requestStartTime = Date.now();
    const url = new URL(request.url);
    console.log(`[Webhook] >>> ${request.method} ${url.pathname}`);
    if (request.method !== "POST" || url.pathname !== "/") {
        console.log(`[Webhook] Invalid method/path. Returning 405/404.`);
        return new Response("Not Found or Method Not Allowed", { status: url.pathname === "/" ? 405 : 404 });
    }
    let update;
    try {
        const contentType = request.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            console.error("[Webhook] Invalid content-type:", contentType);
            return new Response("Invalid Content-Type", { status: 415 });
        }
        update = await request.json();
        if (update && update.update_id) {
            // Process updates asynchronously to quickly respond to Telegram
            Promise.resolve().then(() => {
                if (update.message) {
                    console.log(`[Webhook] Update ${update.update_id} -> handleMessage`);
                    handleMessage(update.message).catch(e => {
                         console.error(`!!! [Webhook] Uncaught error in handleMessage for update ${update.update_id}:`, e.stack);
                         sendMessage(ADMIN_CHAT_ID, `🆘 Uncaught handleMessage Error: ${e.message}`).catch(()=>{});
                    });
                } else if (update.callback_query) {
                    console.log(`[Webhook] Update ${update.update_id} -> handleCallbackQuery`);
                    handleCallbackQuery(update.callback_query).catch(e => {
                         console.error(`!!! [Webhook] Uncaught error in handleCallbackQuery for update ${update.update_id}:`, e.stack);
                         sendMessage(ADMIN_CHAT_ID, `🆘 Uncaught handleCallbackQuery Error: ${e.message}`).catch(()=>{});
                    });
                } else {
                    console.log(`[Webhook] Update ${update.update_id} has unhandled type:`, Object.keys(update));
                }
            }).catch(e => console.error("Error in async update processing wrapper:", e)); // Catch errors from the Promise.resolve().then() chain itself
        } else {
             console.warn("[Webhook] Invalid update structure received:", update);
        }
        const duration = Date.now() - requestStartTime;
        console.log(`<<< [Webhook] Returning 200 OK (Processing started in ${duration}ms)`);
        return new Response("OK", { status: 200 }); // Respond quickly
    } catch (e) {
        const duration = Date.now() - requestStartTime;
        console.error(`!!! [Webhook] Error parsing/handling request (took ${duration}ms):`, e.stack);
        await sendMessage(ADMIN_CHAT_ID, `🆘 CRITICAL Error processing update request: ${e.message}`).catch(ne => console.error("Failed admin notify", ne));
        return new Response("Internal Server Error", { status: 500 });
    }
}
// --- Startup Sequence ---
// ... (Startup sequence remains unchanged) ...
(async () => {
    console.log("--- Bot Initializing ---");
    let botInfo = null;
    let startError = null;
    try {
        if (!REFERENCE_DATE_GREGORIAN) throw new Error("Reference Gregorian Date calculation failed.");
        console.log("[Startup] Getting Bot Info...");
        botInfo = await getBotInfo();
        if (!botInfo || !botInfo.id) {
             console.warn("[Startup] Could not retrieve valid Bot ID. Check token/network. Some features might be limited.");
        } else {
            console.log(`[Startup] Bot Info: ID=${botInfo.id}, Username=${botInfo.username}`);
        }
        console.log("[Startup] Pre-fetching Vazir font...");
        await getVazirFont(); // Ensure font is fetched at startup
        const port = 8000;
        console.log(`[Startup] Attempting to start HTTP server on port ${port}...`);
        serve(handleRequest, {
             port: port,
             onListen({ port, hostname }) {
                console.log(`[Startup] ✅ Server listening on ${hostname}:${port}`);
                const startupTime = DateTime.now().setZone(TEHRAN_TIMEZONE).toFormat("yyyy/MM/dd HH:mm:ss");
                sendMessage(ADMIN_CHAT_ID, `✅ *ربات با موفقیت راه‌اندازی شد\\!*\n🆔 \`${botInfo?.id || 'N/A'}\`\n👤 @${botInfo?.username || 'N/A'}\n⏰ \`${startupTime}\`\n💾 Supabase`)
                    .catch(e => console.error("[Startup] Failed to send startup notification:", e.stack));
             },
             onError(error) { // This is for errors during server listening setup (e.g., port in use)
                console.error("!!! [Startup] SERVER LISTENING ERROR:", error);
                startError = error; // Capture the error
                // This error often means the server couldn't start, so Deno might exit.
                // Send a message if possible, but the process might terminate.
                sendMessage(ADMIN_CHAT_ID, `🆘 خطای مرگبار: سرور ربات نتوانست شروع به کار کند: ${error.message}`)
                    .catch(e => console.error("[Startup] Failed to send server start error notification:", e.stack));
                // Deno.exit(1); // Consider exiting if server fails to start
             }
        });
        console.log(`[Startup] Server setup initiated. Waiting for 'onListen'...`);
    } catch (e) { // This catches errors in the immediate async block (e.g., initial getBotInfo, font fetch)
        console.error("!!! CRITICAL STARTUP ERROR (before server listen):", e.stack);
        startError = e;
        try {
            // Try to send a message, but network or other issues might prevent it
            await sendMessage(ADMIN_CHAT_ID, `🆘 CRITICAL BOT STARTUP ERROR: ${e.message}`).catch(ne => console.error("Failed admin notify on critical startup error", ne));
        } catch (notifyError) { /* Ignore */ }
        // Deno.exit(1); // Consider exiting if critical pre-server setup fails
    }
// This final log might be misleading if the server setup failed in onError
    // It indicates the try-catch block for pre-server setup completed.
    console.log(`--- Bot Initialization ${startError ? 'FAILED (see errors above)' : 'Complete (Server starting or listening)'} ---`);
})();
