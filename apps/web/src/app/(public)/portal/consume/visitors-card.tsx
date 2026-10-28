'use client';

import { Copy, Loader2, Share2, Trash2, UserPlus, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type {
  CustomerAuthorizedPersonDto,
  PortalAccessCredentialDto,
  PortalFacilityDto,
  PortalSessionDto,
} from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { portalApiFetch } from '@/lib/portal/portal-fetch';

const OTHER = '__other';

/**
 * Personas autorizadas (familiar, empleado, mudanzas) y pases de visita de
 * un solo uso para hoy. El equipo ve a quién autoriza y quién viene.
 */
export function VisitorsCard({
  session,
  facilities,
}: {
  session: PortalSessionDto;
  facilities: PortalFacilityDto[];
}) {
  const t = useTranslations('portal.consume.visitors');
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const [people, setPeople] = useState<CustomerAuthorizedPersonDto[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [passOpen, setPassOpen] = useState(false);
  const [who, setWho] = useState<string>(OTHER);
  const [otherName, setOtherName] = useState('');
  const [facilityId, setFacilityId] = useState(facilities[0]?.id ?? '');
  const [pass, setPass] = useState<PortalAccessCredentialDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    portalApiFetch<CustomerAuthorizedPersonDto[]>('/portal/me/authorized-persons', {
      headers,
      requiresAuth: false,
    })
      .then((p) => {
        if (!cancelled) setPeople(p);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  useEffect(() => {
    if (!facilityId && facilities[0]) setFacilityId(facilities[0].id);
  }, [facilities, facilityId]);

  async function addPerson() {
    setBusy(true);
    try {
      const created = await portalApiFetch<CustomerAuthorizedPersonDto>(
        '/portal/me/authorized-persons',
        {
          method: 'POST',
          json: {
            fullName: name.trim(),
            relationship: relationship.trim(),
            phone: phone.trim(),
            canAccess: true,
          },
          headers,
          requiresAuth: false,
        },
      );
      setPeople((p) => [...p, created]);
      setName('');
      setRelationship('');
      setPhone('');
      setAdding(false);
      toast.success(t('added'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('error'));
    } finally {
      setBusy(false);
    }
  }

  async function removePerson(id: string) {
    try {
      await portalApiFetch(`/portal/me/authorized-persons/${id}`, {
        method: 'DELETE',
        headers,
        requiresAuth: false,
      });
      setPeople((p) => p.filter((x) => x.id !== id));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('error'));
    }
  }

  async function createPass() {
    setBusy(true);
    try {
      const created = await portalApiFetch<PortalAccessCredentialDto>('/portal/me/access/visitor', {
        method: 'POST',
        json: {
          ...(who === OTHER ? { name: otherName.trim() } : { authorizedPersonId: who }),
          ...(facilities.length > 1 && facilityId ? { facilityId } : {}),
        },
        headers,
        requiresAuth: false,
      });
      setPass(created);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('error'));
    } finally {
      setBusy(false);
    }
  }

  function shareText(p: PortalAccessCredentialDto): string {
    const facility = facilities.find((f) => f.id === facilityId) ?? facilities[0];
    return t('shareText', {
      pin: p.value ?? '',
      facility: facility
        ? `${facility.name}${facility.address ? `, ${facility.address}` : ''}`
        : '',
    });
  }

  async function share(p: PortalAccessCredentialDto) {
    const text = shareText(p);
    if (navigator.share) {
      await navigator.share({ text }).catch(() => undefined);
    } else {
      await navigator.clipboard?.writeText(text);
      toast.success(t('copied'));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-4 w-4" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          size="sm"
          onClick={() => {
            setPass(null);
            setWho(people[0]?.id ?? OTHER);
            setPassOpen(true);
          }}
        >
          {t('newPass')}
        </Button>

        <div className="space-y-2 border-t pt-3">
          <p className="text-sm font-medium">{t('peopleTitle')}</p>
          {people.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('peopleEmpty')}</p>
          ) : (
            <ul className="space-y-1">
              {people.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    {p.fullName}
                    {p.relationship ? (
                      <span className="text-muted-foreground"> · {p.relationship}</span>
                    ) : null}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('remove')}
                    onClick={() => void removePerson(p.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {adding ? (
            <div className="grid gap-2 sm:grid-cols-3">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('namePlaceholder')}
                className="text-base sm:text-sm"
              />
              <Input
                value={relationship}
                onChange={(e) => setRelationship(e.target.value)}
                placeholder={t('relationshipPlaceholder')}
                className="text-base sm:text-sm"
              />
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder={t('phonePlaceholder')}
                className="text-base sm:text-sm"
              />
              <div className="flex gap-2 sm:col-span-3">
                <Button
                  size="sm"
                  disabled={busy || name.trim().length < 2}
                  onClick={() => void addPerson()}
                >
                  {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  {t('save')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                  {t('cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <UserPlus className="mr-1 h-4 w-4" /> {t('addPerson')}
            </Button>
          )}
        </div>
      </CardContent>

      <Dialog open={passOpen} onOpenChange={setPassOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('passTitle')}</DialogTitle>
            <DialogDescription>{t('passDescription')}</DialogDescription>
          </DialogHeader>
          {pass ? (
            <div className="space-y-3 text-center">
              <p className="font-mono text-3xl tracking-[0.3em]">{pass.value}</p>
              <p className="text-xs text-muted-foreground">{t('passValidToday')}</p>
              <div className="flex justify-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void share(pass)}>
                  <Share2 className="mr-1 h-4 w-4" /> {t('share')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(pass.value ?? '');
                    toast.success(t('copied'));
                  }}
                >
                  <Copy className="mr-1 h-4 w-4" /> {t('copy')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="visitor-who">{t('whoLabel')}</Label>
                <select
                  id="visitor-who"
                  value={who}
                  onChange={(e) => setWho(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
                >
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.fullName}
                    </option>
                  ))}
                  <option value={OTHER}>{t('someoneElse')}</option>
                </select>
              </div>
              {who === OTHER && (
                <Input
                  value={otherName}
                  onChange={(e) => setOtherName(e.target.value)}
                  placeholder={t('visitorNamePlaceholder')}
                  className="text-base sm:text-sm"
                />
              )}
              {facilities.length > 1 && (
                <div className="space-y-1">
                  <Label htmlFor="visitor-facility">{t('facilityLabel')}</Label>
                  <select
                    id="visitor-facility"
                    value={facilityId}
                    onChange={(e) => setFacilityId(e.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
                  >
                    {facilities.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <Button
                className="w-full"
                disabled={busy || (who === OTHER && otherName.trim().length < 2)}
                onClick={() => void createPass()}
              >
                {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                {t('createPass')}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
