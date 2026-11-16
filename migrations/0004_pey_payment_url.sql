-- Link de pago de pey (si la API lo devuelve) para mandarlo junto con el QR.
ALTER TABLE ordenes ADD COLUMN pey_payment_url TEXT;
