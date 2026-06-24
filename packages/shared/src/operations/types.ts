import type {
  IncidentSeverityValue,
  IncidentStatusValue,
  ProductSaleStatusValue,
  ProductTypeValue,
  TaskPriorityValue,
  TaskStatusValue,
  TaskTypeValue,
} from './schemas';

/** Punto del checklist instanciado en una tarea (ronda). */
export interface ChecklistItemDto {
  id: string;
  label: string;
  status: 'pending' | 'ok' | 'issue';
  note: string | null;
}

export interface TaskDto {
  id: string;
  type: TaskTypeValue;
  status: TaskStatusValue;
  priority: TaskPriorityValue;
  title: string;
  description: string | null;
  facilityId: string | null;
  facilityName: string | null;
  unitId: string | null;
  unitCode: string | null;
  assignedToUserId: string | null;
  assignedToName: string | null;
  createdByUserId: string | null;
  /** Plan de mantenimiento recurrente que la generó (null si es manual). */
  maintenancePlanId: string | null;
  /** Puntos a marcar (rondas). Vacío si la tarea no tiene checklist. */
  checklist: ChecklistItemDto[];
  dueDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCommentDto {
  id: string;
  taskId: string;
  authorUserId: string | null;
  authorName: string | null;
  body: string;
  createdAt: string;
}

export interface IncidentDto {
  id: string;
  status: IncidentStatusValue;
  severity: IncidentSeverityValue;
  title: string;
  description: string | null;
  facilityId: string | null;
  facilityName: string | null;
  unitId: string | null;
  unitCode: string | null;
  customerId: string | null;
  customerName: string | null;
  contractId: string | null;
  contractNumber: string | null;
  assignedToUserId: string | null;
  assignedToName: string | null;
  reportedByUserId: string | null;
  reportedByName: string | null;
  reportedByExternal: string | null;
  occurredAt: string | null;
  resolvedAt: string | null;
  dismissedAt: string | null;
  resolution: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentCommentDto {
  id: string;
  incidentId: string;
  authorUserId: string | null;
  authorName: string | null;
  body: string;
  createdAt: string;
}

export interface ProductDto {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  type: ProductTypeValue;
  price: number;
  taxRate: number;
  isActive: boolean;
  totalStock: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductStockDto {
  id: string;
  productId: string;
  facilityId: string;
  facilityName: string;
  quantity: number;
  updatedAt: string;
}

export interface ProductSaleItemDto {
  id: string;
  productId: string;
  productName: string;
  unitPrice: number;
  quantity: number;
  taxRate: number;
  lineSubtotal: number;
  lineTotal: number;
}

export interface ProductSaleDto {
  id: string;
  facilityId: string;
  facilityName: string;
  customerId: string | null;
  customerName: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  status: ProductSaleStatusValue;
  total: number;
  notes: string | null;
  soldByUserId: string | null;
  soldByName: string | null;
  soldAt: string;
  cancelledAt: string | null;
  items: ProductSaleItemDto[];
}
