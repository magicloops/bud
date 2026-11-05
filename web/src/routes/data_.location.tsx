import { createFileRoute } from '@tanstack/react-router'
import { LocationScreen } from '@/components/location-screen'
export const Route = createFileRoute('/data_/location')({ component: LocationScreen })
