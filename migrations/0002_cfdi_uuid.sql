-- Folio fiscal SAT (UUID) aparte del id interno de Facturapi
ALTER TABLE ordenes ADD COLUMN cfdi_uuid TEXT;
