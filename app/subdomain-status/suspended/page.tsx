export default function SuspendedPage() {
  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <div style={{ ...styles.iconCircle, background: '#FFF6E5', color: '#B8860B' }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" />
            <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" />
          </svg>
        </div>
        <h1 style={styles.h1}>هذا الموقع غير نشط حاليًا</h1>
        <p style={styles.p}>
          تم إيقاف هذا النطاق مؤقتًا من قبل الإدارة. إذا كنت صاحب هذا الموقع، يرجى
          التواصل مع الدعم الفني لمنصة مدعوم لمعرفة السبب وإعادة التفعيل.
        </p>
        <Brand />
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div style={styles.brand}>
      <div style={styles.brandMark}>م</div>
      <div style={styles.brandName}>منصة مدعوم</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 20, background: '#F7F7F7', fontFamily: "'Cairo', sans-serif", direction: 'rtl',
  },
  card: {
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: 16, padding: '40px 32px',
    maxWidth: 420, width: '100%', textAlign: 'center', boxShadow: '0 8px 24px rgba(15,60,110,0.08)',
  },
  iconCircle: {
    width: 64, height: 64, borderRadius: '50%', display: 'flex',
    alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px',
  },
  h1: { fontSize: 19, fontWeight: 800, marginBottom: 10, color: '#2F3136' },
  p: { fontSize: 14, color: '#757575', lineHeight: 1.8, marginBottom: 22 },
  brand: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: 24, paddingTop: 20, borderTop: '1px solid #E5E7EB',
  },
  brandMark: {
    width: 24, height: 24, borderRadius: 7,
    background: 'linear-gradient(155deg, #4C97E8, #1879C5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#fff', fontWeight: 800, fontSize: 11,
  },
  brandName: { fontSize: 12.5, fontWeight: 700, color: '#757575' },
};
