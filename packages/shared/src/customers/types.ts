import type {
  ContractBillingCycleValue,
  ContractDepositStatusValue,
  ContractEventTypeValue,
  ContractStatusValue,
  CustomerDocumentTypeValue,
  CustomerTypeValue,
  ReservationStatusValue,
} from './schemas';

export interface CustomerDto {
  id: string;
  customerType: CustomerTypeValue;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  displayName: string;
  documentType: string | null;
  documentNumber: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  country: string;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  notes: string | null;
  tags: string[];
  kycVerified: boolean;
  kycVerifiedAt: string | null;
  activeContracts: number;
  pendingReservations: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerDocumentDto {
  id: string;
  customerId: string;
  type: CustomerDocumentTypeValue;
  fileUrl: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  uploadedByUserId: string | null;
  uploadedByName: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface CustomerDocumentUploadDto {
  uploadUrl: string;
  publicUrl: string;
  expiresIn: number;
  requiredHeaders: Record<string, string>;
  key: string;
}

export interface ContractDto {
  id: string;
  contractNumber: string;
  customerId: string;
  customerName: string;
  unitId: string;
  unitCode: string;
  facilityId: string;
  facilityName: string;
  status: ContractStatusValue;
  startDate: string;
  endDate: string | null;
  signedAt: string | null;
  endingRequestedAt: string | null;
  endedAt: string | null;
  cancelledAt: string | null;
  billingCycle: ContractBillingCycleValue;
  priceMonthly: number;
  discountAmount: number;
  discountReason: string | null;
  effectivePrice: number;
  depositAmount: number;
  depositStatus: ContractDepositStatusValue;
  signedPdfUrl: string | null;
  autoRenew: boolean;
  cancellationNoticeDays: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContractEventDto {
  id: string;
  eventType: ContractEventTypeValue;
  payload: Record<string, unknown>;
  createdByUserId: string | null;
  createdByName: string | null;
  occurredAt: string;
}

export interface ReservationDto {
  id: string;
  unitId: string;
  unitCode: string;
  facilityId: string;
  facilityName: string;
  customerId: string | null;
  customerName: string | null;
  status: ReservationStatusValue;
  validFrom: string;
  validUntil: string;
  depositPaid: boolean;
  depositAmount: number;
  notes: string | null;
  convertedContractId: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
}
