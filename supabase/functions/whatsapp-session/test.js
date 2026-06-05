/**
 * Test script for WhatsApp Session Messages API
 * يمكن تشغيل هذا الملف من المتصفح أو Node.js
 */

// Configuration
const API_BASE = 'https://api.mad3oom.online/v1';
const API_KEY = 'YOUR_API_KEY'; // استبدل بمفتاحك الفعلي

/**
 * Send a session message via WhatsApp
 * @param {string} phoneNumber - Recipient phone number (international format without +)
 * @param {string} message - Message text
 * @param {string} phoneNumberId - Optional: specific phone number ID
 * @returns {Promise<Object>} API response
 */
async function sendSessionMessage(phoneNumber, message, phoneNumberId = null) {
  const payload = {
    to: phoneNumber,
    message: message
  };

  if (phoneNumberId) {
    payload.phone_number_id = phoneNumberId;
  }

  try {
    const response = await fetch(`${API_BASE}/whatsapp/session/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Error:', data);
      return { success: false, error: data };
    }

    console.log('Success:', data);
    return { success: true, data };
  } catch (error) {
    console.error('Network error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Batch send messages
 * @param {Array<{to: string, message: string}>} messages
 */
async function batchSendMessages(messages) {
  console.log(`Sending ${messages.length} messages...`);
  
  for (const msg of messages) {
    console.log(`Sending to ${msg.to}...`);
    await sendSessionMessage(msg.to, msg.message);
    // Add delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

// Example usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sendSessionMessage, batchSendMessages };
}

// Test examples (uncomment to use)
/*
// Single message
sendSessionMessage('201025998920', 'مرحباً بك في خدمتنا');

// Multiple messages
batchSendMessages([
  { to: '201025998920', message: 'رسالة أولى' },
  { to: '201025998921', message: 'رسالة ثانية' }
]);
*/
