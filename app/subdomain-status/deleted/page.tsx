export default function SuspendedPage() {
  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <div style={{ ...styles.iconCircle,background: '#FCEAEA', color: '#D64545' }}>
         <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
  <path d="M3 6H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
  <path d="M8 6V4A2 2 0 0 1 10 2H14A2 2 0 0 1 16 4V6M19 6V20A2 2 0 0 1 17 22H7A2 2 0 0 1 5 20V6H19Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
</svg>
        </div>
        <h1>هذا الموقع لم يعد متاحًا</h1>
<p>تم حذف هذا النطاق الفرعي نهائيًا من منصة مدعوم.</p>
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
