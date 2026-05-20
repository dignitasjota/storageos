import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  AdjustStockInput,
  CreateProductInput,
  CreateProductSaleInput,
  ProductDto,
  ProductSaleDto,
  ProductStockDto,
  SetStockInput,
  UpdateProductInput,
} from '@storageos/shared';

// ============================================================================
// Products
// ============================================================================

export const productsKey = (params?: Record<string, string | undefined>) =>
  ['products', params ?? {}] as const;
export const productKey = (id: string) => ['products', id] as const;
export const productStockKey = (productId: string) => ['products', productId, 'stock'] as const;

export interface ProductsFilter {
  isActive?: boolean;
  type?: string;
}

export function useProducts(params: ProductsFilter = {}) {
  const qs = new URLSearchParams();
  if (params.isActive !== undefined) qs.set('isActive', String(params.isActive));
  if (params.type) qs.set('type', params.type);
  return useQuery({
    queryKey: productsKey({
      ...(params.isActive !== undefined ? { isActive: String(params.isActive) } : {}),
      ...(params.type ? { type: params.type } : {}),
    }),
    queryFn: () => apiFetch<ProductDto[]>(`/products${qs.toString() ? `?${qs}` : ''}`),
  });
}

export function useProduct(id: string | undefined) {
  return useQuery({
    queryKey: id ? productKey(id) : ['products', 'none'],
    queryFn: () => apiFetch<ProductDto>(`/products/${id}`),
    enabled: !!id,
  });
}

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProductInput) =>
      apiFetch<ProductDto>('/products', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['products'] });
    },
  });
}

export function useUpdateProduct(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProductInput) =>
      apiFetch<ProductDto>(`/products/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['products'] });
    },
  });
}

export function useDeleteProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/products/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['products'] });
    },
  });
}

// ============================================================================
// Product stock
// ============================================================================

export function useProductStock(productId: string | undefined) {
  return useQuery({
    queryKey: productId ? productStockKey(productId) : ['products', 'none', 'stock'],
    queryFn: () => apiFetch<ProductStockDto[]>(`/products/${productId}/stock`),
    enabled: !!productId,
  });
}

export function useAdjustStock(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AdjustStockInput) =>
      apiFetch<ProductStockDto>(`/products/${productId}/stock/adjust`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: productStockKey(productId) });
      void qc.invalidateQueries({ queryKey: ['products'] });
    },
  });
}

export function useSetStock(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetStockInput) =>
      apiFetch<ProductStockDto>(`/products/${productId}/stock`, {
        method: 'PUT',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: productStockKey(productId) });
      void qc.invalidateQueries({ queryKey: ['products'] });
    },
  });
}

// ============================================================================
// Product sales
// ============================================================================

export const productSalesKey = (params?: Record<string, string | undefined>) =>
  ['product-sales', params ?? {}] as const;
export const productSaleKey = (id: string) => ['product-sales', id] as const;

export interface ProductSalesFilter {
  customerId?: string;
  facilityId?: string;
  status?: string;
}

export function useProductSales(params: ProductSalesFilter = {}) {
  const qs = new URLSearchParams();
  if (params.customerId) qs.set('customerId', params.customerId);
  if (params.facilityId) qs.set('facilityId', params.facilityId);
  if (params.status) qs.set('status', params.status);
  return useQuery({
    queryKey: productSalesKey(params as Record<string, string | undefined>),
    queryFn: () => apiFetch<ProductSaleDto[]>(`/product-sales${qs.toString() ? `?${qs}` : ''}`),
  });
}

export function useProductSale(id: string | undefined) {
  return useQuery({
    queryKey: id ? productSaleKey(id) : ['product-sales', 'none'],
    queryFn: () => apiFetch<ProductSaleDto>(`/product-sales/${id}`),
    enabled: !!id,
  });
}

export function useCreateProductSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProductSaleInput) =>
      apiFetch<ProductSaleDto>('/product-sales', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['product-sales'] });
      void qc.invalidateQueries({ queryKey: ['products'] });
    },
  });
}

export function useCancelProductSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ProductSaleDto>(`/product-sales/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['product-sales'] });
      void qc.invalidateQueries({ queryKey: ['products'] });
    },
  });
}
