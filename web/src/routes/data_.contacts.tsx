import { createFileRoute } from '@tanstack/react-router'
import { DataScreen } from '@/components/data-screen'
export const Route = createFileRoute('/data_/contacts')({ component: () => <DataScreen browse /> })
