import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";

type CardProps = {
  title: string;
  description?: ComponentChildren;
  actions?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
  flush?: boolean;
};

/** A titled region. Cards are h2 sections; anything inside a card is h3 or below. */
export function Card({ title, description, actions, children, class: extra, flush }: CardProps) {
  const id = useId();
  return (
    <section class={`card${extra ? ` ${extra}` : ""}`} aria-labelledby={id}>
      <header class="card-head">
        <div>
          <h2 class="card-title" id={id}>
            {title}
          </h2>
          {description ? <p class="card-desc">{description}</p> : null}
        </div>
        {actions ? <div class="card-actions">{actions}</div> : null}
      </header>
      <div class={flush ? "card-body card-body-flush" : "card-body"}>{children}</div>
    </section>
  );
}

/** Label/value pairs. */
export function Facts({ items }: { items: { label: string; value: ComponentChildren }[] }) {
  return (
    <dl class="facts">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
