export function ProblemView({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="problem-view" id="main-content">
      <section className="problem-card" role="alert">
        <h1>{title}</h1>
        <p>{detail}</p>
      </section>
    </main>
  );
}
