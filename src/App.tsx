import { useEffect } from 'react';
import { recoverInterrupted } from './audio/session';
import { useRoute } from './lib/router';
import { Home } from './screens/Home';
import { Import } from './screens/Import';
import { Print } from './screens/Print';
import { Recording } from './screens/Recording';
import { Records } from './screens/Records';
import { RecordView } from './screens/RecordView';
import { Settings } from './screens/Settings';
import { kickQueue, onQueueProblem } from './stt/queue';
import { toast, Toaster } from './ui/kit';

export function App() {
  const [page, arg] = useRoute();

  useEffect(() => {
    void recoverInterrupted();
    const online = () => kickQueue();
    window.addEventListener('online', online);
    let last: string | null = null;
    const off = onQueueProblem((msg) => {
      if (msg && msg !== last) toast(msg, 6000);
      last = msg;
    });
    return () => {
      window.removeEventListener('online', online);
      off();
    };
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page, arg]);

  let screen;
  switch (page) {
    case 'record':
      screen = <Recording />;
      break;
    case 'r':
      screen = arg ? <RecordView key={arg} id={arg} /> : <Home />;
      break;
    case 'records':
      screen = <Records focusSearch={arg === 'search'} />;
      break;
    case 'settings':
      screen = <Settings anchor={arg} />;
      break;
    case 'import':
      screen = <Import />;
      break;
    case 'print':
      screen = arg ? <Print id={arg} /> : <Home />;
      break;
    default:
      screen = <Home />;
  }

  return (
    <>
      {screen}
      <Toaster />
    </>
  );
}
