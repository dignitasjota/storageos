'use client';

import { Eye, EyeOff, Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { BlogPostDialog } from './blog-post-dialog';

import type { BlogPostDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useBlogPosts, useDeleteBlogPost, useUpdateBlogPost } from '@/lib/blog/hooks';

export default function BlogSettingsPage() {
  const posts = useBlogPosts();
  const update = useUpdateBlogPost();
  const remove = useDeleteBlogPost();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<BlogPostDto | undefined>(undefined);

  function openCreate() {
    setEditing(undefined);
    setDialogOpen(true);
  }

  function openEdit(post: BlogPostDto) {
    setEditing(post);
    setDialogOpen(true);
  }

  async function togglePublish(post: BlogPostDto) {
    try {
      await update.mutateAsync({ id: post.id, input: { isPublished: !post.isPublished } });
      toast.success(post.isPublished ? 'Entrada despublicada.' : 'Entrada publicada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function onDelete(post: BlogPostDto) {
    if (!window.confirm(`¿Borrar «${post.title}»? No se puede deshacer.`)) return;
    try {
      await remove.mutateAsync(post.id);
      toast.success('Entrada borrada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Blog ({posts.data?.length ?? 0})</CardTitle>
          <Button onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" />
            Nueva entrada
          </Button>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            Publica contenido en la web pública para mejorar tu posicionamiento SEO. Las entradas
            publicadas aparecen en <span className="font-mono">/blog</span> de tu web.
          </p>
          {posts.isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (posts.data?.length ?? 0) === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              Aún no hay entradas. Crea la primera para empezar a atraer tráfico orgánico.
            </p>
          ) : (
            <ul className="divide-y">
              {posts.data!.map((post) => (
                <BlogRow
                  key={post.id}
                  post={post}
                  onEdit={() => openEdit(post)}
                  onTogglePublish={() => togglePublish(post)}
                  onDelete={() => onDelete(post)}
                  busy={update.isPending || remove.isPending}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <BlogPostDialog open={dialogOpen} onOpenChange={setDialogOpen} post={editing} />
    </div>
  );
}

function BlogRow({
  post,
  onEdit,
  onTogglePublish,
  onDelete,
  busy,
}: {
  post: BlogPostDto;
  onEdit: () => void;
  onTogglePublish: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  return (
    <li className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1 cursor-pointer" onClick={onEdit}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium hover:underline">{post.title}</span>
          {post.isPublished ? (
            <Badge>Publicada</Badge>
          ) : (
            <Badge variant="secondary">Borrador</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">/blog/{post.slug}</p>
        {post.excerpt && (
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{post.excerpt}</p>
        )}
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={onTogglePublish}
          disabled={busy}
          aria-label={post.isPublished ? 'Despublicar' : 'Publicar'}
          title={post.isPublished ? 'Despublicar' : 'Publicar'}
        >
          {post.isPublished ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon" onClick={onDelete} disabled={busy} aria-label="Borrar">
          <Trash2 className="size-4 text-muted-foreground" />
        </Button>
      </div>
    </li>
  );
}
