export function Pagination({
  page,
  hasPrevious,
  hasNext,
  busy,
  onPrevious,
  onNext,
}: {
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  busy: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav class="pagination" aria-label="Pagination">
      <span class="muted">Page {page}</span>
      <div class="pagination-buttons">
        <button type="button" class="btn" disabled={!hasPrevious || busy} onClick={onPrevious}>
          Previous
        </button>
        <button type="button" class="btn" disabled={!hasNext || busy} onClick={onNext}>
          Next
        </button>
      </div>
    </nav>
  );
}
