const path = require('node:path')

module.exports = {
  port: Number(process.env.PORT || 3001),
  mongodbUri: process.env.MONGODB_URI,
  localTestStorage: process.env.NODE_ENV === 'test',
  crmDataFile: process.env.CRM_DATA_FILE || path.join(__dirname, '..', 'data', 'crm.json'),
  usersFile: process.env.CRM_USERS_FILE || path.join(__dirname, '..', 'data', 'users.json'),
  admin: {
    name: process.env.ADMIN_NAME,
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
  },
  meta: {
    appSecret: process.env.META_APP_SECRET,
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN,
    leadAccessToken: process.env.META_LEAD_ACCESS_TOKEN,
    graphApiVersion: process.env.META_GRAPH_API_VERSION,
    publicWebhookUrl: process.env.META_WEBHOOK_PUBLIC_URL,
  },
  leadWebhookSecrets: {
    website: process.env.WEBSITE_WEBHOOK_SECRET,
    referral: process.env.REFERRAL_WEBHOOK_SECRET,
    generic: process.env.LEAD_WEBHOOK_SECRET,
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    fromNumber: process.env.TWILIO_FROM_NUMBER,
  },
}
