import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import styles from './RouteErrorPage.module.css';

/** Router-level error boundary: friendly message, no stack traces shown to users. */
export function RouteErrorPage() {
  const error = useRouteError();
  const title = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : 'Something went wrong';
  if (!isRouteErrorResponse(error)) console.error(error);
  return (
    <main className={styles.page}>
      <h1>{title}</h1>
      <p>Please reload the page. If the problem continues, try again later.</p>
      <p>
        <Link to="/">Go to the home page</Link>
      </p>
    </main>
  );
}
