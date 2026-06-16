# Send Email Feature - Implementation Guide

## Overview
The "إرسال بريد" (Send Email) feature allows administrators to send emails to individual users or broadcast to all users in the platform.

## Implementation Details

### 1. Frontend Components

#### HTML Page
- **Location**: `/admin/send-email.html`
- **Features**:
  - Arabic RTL interface
  - Radio buttons to select single user or all users
  - Dropdown populated with users from database
  - Subject and body text fields
  - Loading states and success/error notifications

#### JavaScript Module
- **Location**: `/assets/js/admin/send-email.js`
- **Functionality**:
  - Fetches users from `profiles` table
  - Handles single user or broadcast email sending
  - Shows real-time progress when sending to all users
  - Toast notifications for success/error feedback
  - Proper async/await error handling

### 2. Backend Integration

#### Supabase Edge Function
- **Function Name**: `send-ticket-email`
- **Version**: Updated (v9)
- **New Feature**: Added support for `CUSTOM` event type
- **How It Works**:
  - Existing function that uses Resend API
  - Now supports custom emails via `event: 'CUSTOM'`
  - Accepts `subject` and `message` parameters
  - Generates HTML email with proper Arabic RTL formatting

#### Function Parameters
```javascript
{
  event: 'CUSTOM',           // Event type for custom emails
  customer_email: string,    // Recipient email
  customer_name: string,     // Recipient name (optional)
  subject: string,           // Email subject
  message: string            // Email body (supports HTML)
}
```

### 3. Sidebar Navigation
- **Updated**: `/assets/components/sidebar.html`
- **Added**: New menu item "إرسال بريد" with mail icon
- **Position**: After "إدارة الاقتراحات"

### 4. Database Integration
- **Table Used**: `profiles`
- **Fields Queried**: `id`, `email`, `full_name`
- **Purpose**: Fetching all users for recipient selection

## Usage Flow

### Send to Single User
1. Select "مستخدم واحد" radio button
2. Choose user from dropdown
3. Enter subject and message
4. Click "إرسال الرسالة"
5. Email sent via Resend API

### Send to All Users
1. Select "كل المستخدمين" radio button
2. Dropdown gets disabled
3. Enter subject and message
4. Click "إرسال الرسالة"
5. System iterates through all users
6. Progress counter shows: "تم الإرسال: X/Total"
7. Success notification on completion

## Security Considerations
- Edge function uses environment variables for Resend API key
- No JWT verification required (internal admin function)
- CORS enabled for frontend access
- Admin authentication required via Supabase Auth

## Environment Variables Required
- `RESEND_API_KEY`: Your Resend API key
- `EMAIL_FROM`: Sender email (default: tickets@mad3oom.online)

## Error Handling
- User-friendly Arabic error messages
- Console logging for debugging
- Toast notifications for user feedback
- Graceful handling of failed sends in batch mode

## Future Enhancements (Optional)
- Email templates
- Schedule sending
- Email history/logs
- Rich text editor for message body
- Attachment support
- Email preview before sending
- User segmentation (send to specific groups)

## Testing Checklist
- [x] Sidebar menu item appears
- [x] Page loads correctly
- [x] Users dropdown populates
- [x] Single user email works
- [x] All users broadcast works
- [x] Loading states display correctly
- [x] Success/error toasts appear
- [x] Arabic text displays properly (RTL)
- [x] Edge function handles CUSTOM event
- [x] Email received with correct formatting

## Notes
- All UI labels are in Arabic as required
- RTL support implemented
- Minimal code approach followed
- Uses existing Resend integration (no new setup needed)
- No modifications to GitHub or deployment configs
