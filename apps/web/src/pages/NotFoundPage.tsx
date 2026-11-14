import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <section aria-labelledby="nf-title">
      <h1 id="nf-title">Page not found</h1>
      <p>The page you are looking for does not exist or has moved.</p>
      <p>
        <Link to="/">Go to the home page</Link>
      </p>
    </section>
  );
}
