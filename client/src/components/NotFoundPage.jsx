import { Link } from 'react-router-dom';

export const NotFoundPage = () => (
  <div className="py-16 text-center">
    <h1 className="text-xl font-semibold">That page does not exist</h1>
    <p className="mt-2 text-sm text-steel"><Link className="text-accent underline" to="/">Back to the dashboard</Link></p>
  </div>
);
