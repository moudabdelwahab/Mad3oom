```js id="jlwm4v"
// ============================================
// WhatsApp Embedded Signup
// ============================================

// بيانات الجلسة المؤقتة
let sessionInfo = {
  phoneNumberId: null,
  wabaId: null,
};

// ============================================
// Facebook SDK Init
// ============================================

window.fbAsyncInit = function () {

  FB.init({
    appId: '1510313544014876',
    cookie: true,
    xfbml: true,
    version: 'v21.0'
  });

  console.log('Facebook SDK Initialized');

};

// ============================================
// Session Info Listener
// ============================================

window.addEventListener('message', (event) => {

  console.log('Embedded Signup Event:', event);

  try {

    const data =
      typeof event.data === 'string'
        ? JSON.parse(event.data)
        : event.data;

    // حفظ بيانات الواتساب
    if (data?.type === 'WA_EMBEDDED_SIGNUP') {

      sessionInfo.phoneNumberId =
        data.data?.phone_number_id || null;

      sessionInfo.wabaId =
        data.data?.waba_id || null;

      console.log('Session Info Saved:', sessionInfo);

    }

  } catch (err) {
    console.log('Message parse skipped');
  }

});

// ============================================
// Exchange Code
// ============================================

async function exchangeCode(code) {

  try {

    const response = await fetch(
      'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/exchange-token',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json'
        },

        body: JSON.stringify({
          code
        })
      }
    );

    const data = await response.json();

    console.log('Exchange Response:', data);

    if (data.access_token) {

      // حفظ مؤقت للتجربة
      localStorage.setItem(
        'wa_access_token',
        data.access_token
      );

      localStorage.setItem(
        'wa_phone_number_id',
        sessionInfo.phoneNumberId || ''
      );

      localStorage.setItem(
        'wa_waba_id',
        sessionInfo.wabaId || ''
      );

      alert('تم ربط واتساب بنجاح 🔥');

    } else {

      console.error(data);

      alert('فشل في جلب Access Token');

    }

  } catch (error) {

    console.error(error);

    alert('حدث خطأ أثناء الربط');

  }

}

// ============================================
// Facebook Login Callback
// ============================================

function fbLoginCallback(response) {

  console.log('FB Login Response:', response);

  if (response.authResponse) {

    const code = response.authResponse.code;

    console.log('Authorization Code:', code);

    // إرسال code للـ backend
    exchangeCode(code);

  } else {

    console.log('User cancelled login');

  }

}

// ============================================
// Launch Embedded Signup
// ============================================

function launchWhatsAppSignup() {

  FB.login(
    fbLoginCallback,
    {
      config_id: '2268694463535485',

      response_type: 'code',

      override_default_response_type: true,

      extras: {
        version: 'v4'
      }
    }
  );

}

// ============================================
// Button Event
// ============================================

document
  .getElementById('wa-connect-btn')
  .addEventListener(
    'click',
    launchWhatsAppSignup
  );
```
