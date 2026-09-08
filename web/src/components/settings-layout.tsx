import { Link } from '@tanstack/react-router'
import './settings-layout.css'

export function SettingsNavigation() {
  return <nav aria-label="Settings navigation" className="flex flex-wrap gap-2">
    <Link to="/" className="settings-action">← Workspace</Link>
    <Link to="/settings" className="settings-action" activeProps={{ 'aria-current': 'page' }}>Account</Link>
    <Link to="/data" className="settings-action" activeOptions={{ exact: true }} activeProps={{ 'aria-current': 'page' }}>Data sources</Link>
    <Link to="/data/contacts" className="settings-action" activeProps={{ 'aria-current': 'page' }}>Browse data</Link>
    <Link to="/automations" className="settings-action" activeProps={{ 'aria-current': 'page' }}>Automations</Link>
  </nav>
}
