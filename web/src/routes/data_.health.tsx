import { createFileRoute } from '@tanstack/react-router'
import { HealthScreen } from '@/components/health-screen'
export const Route = createFileRoute('/data_/health')({ component: HealthScreen })
