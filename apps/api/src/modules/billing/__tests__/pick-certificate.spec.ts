import * as forge from 'node-forge';

import { pickCertificateForKey } from '../tenant-aeat-credentials.service';

function certFor(keys: forge.pki.rsa.KeyPair, cn: string): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer([{ name: 'commonName', value: cn }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return cert;
}

describe('pickCertificateForKey', () => {
  const ca = forge.pki.rsa.generateKeyPair(512);
  const leaf = forge.pki.rsa.generateKeyPair(512);
  const caCert = certFor(ca, 'CA');
  const leafCert = certFor(leaf, 'TITULAR');

  it('elige el certificado de la clave privada aunque la cadena vaya delante', () => {
    const picked = pickCertificateForKey(
      [
        { cert: caCert, localKeyId: null },
        { cert: leafCert, localKeyId: null },
      ],
      [{ key: leaf.privateKey, localKeyId: null }],
    );
    expect(picked?.subject.getField('CN').value).toBe('TITULAR');
  });

  it('sin poder comparar la clave, usa el localKeyId; si no, el primero', () => {
    const noModulus = {} as forge.pki.PrivateKey;
    expect(
      pickCertificateForKey(
        [
          { cert: caCert, localKeyId: 'aa' },
          { cert: leafCert, localKeyId: 'bb' },
        ],
        [{ key: noModulus, localKeyId: 'bb' }],
      )?.subject.getField('CN').value,
    ).toBe('TITULAR');
    expect(
      pickCertificateForKey([{ cert: caCert, localKeyId: null }], [])?.subject.getField('CN').value,
    ).toBe('CA');
    expect(pickCertificateForKey([], [])).toBeNull();
  });
});
