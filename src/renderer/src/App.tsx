const styles = {
  root: {
    height: '100vh',
    display: 'grid',
    placeItems: 'center',
    margin: 0,
    font: '15px/1.6 system-ui, "Malgun Gothic", sans-serif',
    color: '#1d1d24',
    background: '#f6f6f8',
  },
} as const;

export function App() {
  return (
    <main style={styles.root}>
      <div>
        <h1>LoreWeave</h1>
        <p>원고 폴더를 여는 기능은 다음 단계에서 추가됩니다.</p>
      </div>
    </main>
  );
}
