import AdminPage from './AdminPage';

// 管理后台为独立应用；用户对话端为 apps/web（开发时 http://localhost:5173）
const CHAT_URL = 'http://localhost:5173/';

export default function App() {
  return <AdminPage goChat={() => window.open(CHAT_URL, '_blank')} />;
}