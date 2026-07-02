// middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const CHECK_STATUS_URL = 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/check-subdomain-status';
const ROOT_DOMAIN = 'mad3oom.online';

export async function middleware(req: NextRequest) {
  const hostname = req.headers.get('host') || '';

  // تجاهل الدومين الأساسي نفسه ودومينات المعاينة المحلية
  if (
    hostname === ROOT_DOMAIN ||
    hostname === `www.${ROOT_DOMAIN}` ||
    hostname.includes('localhost') ||
    hostname.includes('vercel.app')
  ) {
    return NextResponse.next();
  }

  // تأكد إننا فعلاً على نطاق فرعي من mad3oom.online
  if (!hostname.endsWith(`.${ROOT_DOMAIN}`)) {
    return NextResponse.next();
  }

  try {
    const res = await fetch(`${CHECK_STATUS_URL}?hostname=${encodeURIComponent(hostname)}`, {
      // كاش خفيف لتقليل عدد النداءات لنفس الدومين خلال ثواني قليلة
      next: { revalidate: 10 },
    });
    const data = await res.json();

    if (data.status === 'suspended') {
      const url = req.nextUrl.clone();
      url.pathname = '/subdomain-status/suspended';
      return NextResponse.rewrite(url);
    }

    if (data.status === 'deleted') {
      const url = req.nextUrl.clone();
      url.pathname = '/subdomain-status/deleted';
      return NextResponse.rewrite(url);
    }

    if (data.status === 'not_found') {
      const url = req.nextUrl.clone();
      url.pathname = '/subdomain-status/not-found';
      return NextResponse.rewrite(url);
    }

    if (data.status === 'pending_setup') {
      const url = req.nextUrl.clone();
      url.pathname = '/subdomain-status/pending';
      return NextResponse.rewrite(url);
    }

    // active → نكمل عادي، ونمرر بيانات النطاق كـ header لو الصفحة محتاجاها (اللوجو مثلًا)
    const response = NextResponse.next();
    if (data.logo_url) response.headers.set('x-subdomain-logo', data.logo_url);
    if (data.user_id) response.headers.set('x-subdomain-user-id', data.user_id);
    return response;
  } catch {
    // لو الفحص فشل لأي سبب (مشكلة شبكة مؤقتة)، نكمل عادي بدل ما نوقف الموقع بالكامل
    return NextResponse.next();
  }
}

export const config = {
  matcher: [
    /*
     * طبّق الـ middleware على كل شيء ما عدا:
     * - ملفات static/_next
     * - مسارات API الداخلية بتاعتك
     */
    '/((?!_next/static|_next/image|favicon.ico|api/).*)',
  ],
};
