export function WikiBrand() {
  return (
    <span className="wiki-brand" aria-label="Framework Wiki">
      <span className="wiki-wordmark" aria-hidden="true">
        <img src="/docs/framework.png" alt="" width={1000} height={1000} />
      </span>
      <span className="wiki-brand-label" aria-hidden="true">Wiki</span>
    </span>
  );
}
