/** Placeholder for an area whose full build lands in a later slice. Owner
    actions it will absorb keep living on the classic dashboard meanwhile. */
export function StubView({ title, purpose, demo }: { title: string; purpose: string; demo: boolean }) {
  return (
    <div class="card stub reveal">
      <h1>{title}</h1>
      <p>{purpose}</p>
      {!demo && (
        <p style="margin-top:10px">
          Until this area is built, <a href="/">manage this on the classic dashboard →</a>
        </p>
      )}
    </div>
  );
}
