const nodemailer = require('nodemailer');

function getTransport() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return null; // dry-run mode — caller should just log instead of sending
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

async function sendEmail({ to, subject, text }) {
  const transport = getTransport();
  if (!transport) {
    console.log(`\n[DRY RUN — no GMAIL_USER/GMAIL_APP_PASSWORD set] Would send to: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(text);
    console.log('--- end of email ---\n');
    return { dryRun: true };
  }
  return transport.sendMail({
    from: `"Clear Water Spa Service" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    text,
  });
}

module.exports = { sendEmail };
