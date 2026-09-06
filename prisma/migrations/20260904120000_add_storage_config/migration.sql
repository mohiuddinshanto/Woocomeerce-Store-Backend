-- Add storageConfig column to StoreConfig for Hostinger Object Storage
ALTER TABLE `StoreConfig` ADD COLUMN `storageConfig` JSON NULL;
