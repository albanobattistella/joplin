import { fileContentEqual, setupDatabaseAndSynchronizer, supportDir, switchClient, objectsEqual, checkThrowAsync, msleep } from '../testing/test-utils';
import Folder from '../models/Folder';
import Note from '../models/Note';
import Setting from '../models/Setting';
import BaseItem from '../models/BaseItem';
import MasterKey from '../models/MasterKey';
import EncryptionService from '../services/EncryptionService';
import { setEncryptionEnabled } from '../services/synchronizer/syncInfoUtils';

let service: EncryptionService = null;

describe('services_EncryptionService', function() {

	beforeEach(async (done) => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
		service = new EncryptionService();
		BaseItem.encryptionService_ = service;
		setEncryptionEnabled(true);
		done();
	});

	it('should encode and decode header', (async () => {
		const header = {
			encryptionMethod: EncryptionService.METHOD_SJCL,
			masterKeyId: '01234568abcdefgh01234568abcdefgh',
		};

		const encodedHeader = service.encodeHeader_(header);
		const decodedHeader = service.decodeHeaderBytes_(encodedHeader);
		delete decodedHeader.length;

		expect(objectsEqual(header, decodedHeader)).toBe(true);
	}));

	it('should generate and decrypt a master key', (async () => {
		const masterKey = await service.generateMasterKey('123456');
		expect(!!masterKey.content).toBe(true);

		let hasThrown = false;
		try {
			await service.decryptMasterKey_(masterKey, 'wrongpassword');
		} catch (error) {
			hasThrown = true;
		}

		expect(hasThrown).toBe(true);

		const decryptedMasterKey = await service.decryptMasterKey_(masterKey, '123456');
		expect(decryptedMasterKey.length).toBe(512);
	}));

	it('should upgrade a master key', (async () => {
		// Create an old style master key
		let masterKey = await service.generateMasterKey('123456', {
			encryptionMethod: EncryptionService.METHOD_SJCL_2,
		});
		masterKey = await MasterKey.save(masterKey);

		let upgradedMasterKey = await service.upgradeMasterKey(masterKey, '123456');
		upgradedMasterKey = await MasterKey.save(upgradedMasterKey);

		// Check that master key has been upgraded (different ciphertext)
		expect(masterKey.content).not.toBe(upgradedMasterKey.content);

		// Check that master key plain text is still the same
		const plainTextOld = await service.decryptMasterKey_(masterKey, '123456');
		const plainTextNew = await service.decryptMasterKey_(upgradedMasterKey, '123456');
		expect(plainTextOld).toBe(plainTextNew);

		// Check that old content can be decrypted with new master key
		await service.loadMasterKey(masterKey, '123456', true);
		const cipherText = await service.encryptString('some secret');
		const plainTextFromOld = await service.decryptString(cipherText);

		await service.loadMasterKey(upgradedMasterKey, '123456', true);
		const plainTextFromNew = await service.decryptString(cipherText);

		expect(plainTextFromOld).toBe(plainTextFromNew);
	}));

	it('should not upgrade master key if invalid password', (async () => {
		const masterKey = await service.generateMasterKey('123456', {
			encryptionMethod: EncryptionService.METHOD_SJCL_2,
		});

		await checkThrowAsync(async () => await service.upgradeMasterKey(masterKey, '777'));
	}));

	it('should require a checksum only for old master keys', (async () => {
		const masterKey = await service.generateMasterKey('123456', {
			encryptionMethod: EncryptionService.METHOD_SJCL_2,
		});

		expect(!!masterKey.checksum).toBe(true);
		expect(!!masterKey.content).toBe(true);
	}));

	it('should not require a checksum for new master keys', (async () => {
		const masterKey = await service.generateMasterKey('123456', {
			encryptionMethod: EncryptionService.METHOD_SJCL_4,
		});

		expect(!masterKey.checksum).toBe(true);
		expect(!!masterKey.content).toBe(true);

		const decryptedMasterKey = await service.decryptMasterKey_(masterKey, '123456');
		expect(decryptedMasterKey.length).toBe(512);
	}));

	it('should throw an error if master key decryption fails', (async () => {
		const masterKey = await service.generateMasterKey('123456', {
			encryptionMethod: EncryptionService.METHOD_SJCL_4,
		});

		const hasThrown = await checkThrowAsync(async () => await service.decryptMasterKey_(masterKey, 'wrong'));

		expect(hasThrown).toBe(true);
	}));

	it('should return the master keys that need an upgrade', (async () => {
		const masterKey1 = await MasterKey.save(await service.generateMasterKey('123456', {
			encryptionMethod: EncryptionService.METHOD_SJCL_2,
		}));

		const masterKey2 = await MasterKey.save(await service.generateMasterKey('123456', {
			encryptionMethod: EncryptionService.METHOD_SJCL,
		}));

		await MasterKey.save(await service.generateMasterKey('123456'));

		const needUpgrade = service.masterKeysThatNeedUpgrading(await MasterKey.all());

		expect(needUpgrade.length).toBe(2);
		expect(needUpgrade.map(k => k.id).sort()).toEqual([masterKey1.id, masterKey2.id].sort());
	}));

	it('should encrypt and decrypt with a master key', (async () => {
		let masterKey = await service.generateMasterKey('123456');
		masterKey = await MasterKey.save(masterKey);

		await service.loadMasterKey(masterKey, '123456', true);

		const cipherText = await service.encryptString('some secret');
		const plainText = await service.decryptString(cipherText);

		expect(plainText).toBe('some secret');

		// Test that a long string, that is going to be split into multiple chunks, encrypt
		// and decrypt properly too.
		let veryLongSecret = '';
		for (let i = 0; i < service.chunkSize() * 3; i++) veryLongSecret += Math.floor(Math.random() * 9);

		const cipherText2 = await service.encryptString(veryLongSecret);
		const plainText2 = await service.decryptString(cipherText2);

		expect(plainText2 === veryLongSecret).toBe(true);
	}));

	it('should decrypt various encryption methods', (async () => {
		let masterKey = await service.generateMasterKey('123456');
		masterKey = await MasterKey.save(masterKey);
		await service.loadMasterKey(masterKey, '123456', true);

		{
			const cipherText = await service.encryptString('some secret', {
				encryptionMethod: EncryptionService.METHOD_SJCL_2,
			});
			const plainText = await service.decryptString(cipherText);
			expect(plainText).toBe('some secret');
			const header = await service.decodeHeaderString(cipherText);
			expect(header.encryptionMethod).toBe(EncryptionService.METHOD_SJCL_2);
		}

		{
			const cipherText = await service.encryptString('some secret', {
				encryptionMethod: EncryptionService.METHOD_SJCL_3,
			});
			const plainText = await service.decryptString(cipherText);
			expect(plainText).toBe('some secret');
			const header = await service.decodeHeaderString(cipherText);
			expect(header.encryptionMethod).toBe(EncryptionService.METHOD_SJCL_3);
		}
	}));

	it('should fail to decrypt if master key not present', (async () => {
		let masterKey = await service.generateMasterKey('123456');
		masterKey = await MasterKey.save(masterKey);

		await service.loadMasterKey(masterKey, '123456', true);

		const cipherText = await service.encryptString('some secret');

		await service.unloadMasterKey(masterKey);

		const hasThrown = await checkThrowAsync(async () => await service.decryptString(cipherText));

		expect(hasThrown).toBe(true);
	}));


	it('should fail to decrypt if data tampered with', (async () => {
		let masterKey = await service.generateMasterKey('123456');
		masterKey = await MasterKey.save(masterKey);

		await service.loadMasterKey(masterKey, '123456', true);

		let cipherText = await service.encryptString('some secret');
		cipherText += 'ABCDEFGHIJ';

		const hasThrown = await checkThrowAsync(async () => await service.decryptString(cipherText));

		expect(hasThrown).toBe(true);
	}));

	it('should encrypt and decrypt notes and folders', (async () => {
		let masterKey = await service.generateMasterKey('123456');
		masterKey = await MasterKey.save(masterKey);
		await service.loadMasterKey(masterKey, '123456', true);

		const folder = await Folder.save({ title: 'folder' });
		const note = await Note.save({ title: 'encrypted note', body: 'something', parent_id: folder.id });
		const serialized = await Note.serializeForSync(note);
		const deserialized = Note.filter(await Note.unserialize(serialized));

		// Check that required properties are not encrypted
		expect(deserialized.id).toBe(note.id);
		expect(deserialized.parent_id).toBe(note.parent_id);
		expect(deserialized.updated_time).toBe(note.updated_time);

		// Check that at least title and body are encrypted
		expect(!deserialized.title).toBe(true);
		expect(!deserialized.body).toBe(true);

		// Check that encrypted data is there
		expect(!!deserialized.encryption_cipher_text).toBe(true);

		const encryptedNote = await Note.save(deserialized);
		const decryptedNote = await Note.decrypt(encryptedNote);

		expect(decryptedNote.title).toBe(note.title);
		expect(decryptedNote.body).toBe(note.body);
		expect(decryptedNote.id).toBe(note.id);
		expect(decryptedNote.parent_id).toBe(note.parent_id);
	}));

	it('should encrypt and decrypt files', (async () => {
		let masterKey = await service.generateMasterKey('123456');
		masterKey = await MasterKey.save(masterKey);
		await service.loadMasterKey(masterKey, '123456', true);

		const sourcePath = `${supportDir}/photo.jpg`;
		const encryptedPath = `${Setting.value('tempDir')}/photo.crypted`;
		const decryptedPath = `${Setting.value('tempDir')}/photo.jpg`;

		await service.encryptFile(sourcePath, encryptedPath);
		await service.decryptFile(encryptedPath, decryptedPath);

		expect(fileContentEqual(sourcePath, encryptedPath)).toBe(false);
		expect(fileContentEqual(sourcePath, decryptedPath)).toBe(true);
	}));

	it('should encrypt invalid UTF-8 data', (async () => {
		let masterKey = await service.generateMasterKey('123456');
		masterKey = await MasterKey.save(masterKey);

		await service.loadMasterKey(masterKey, '123456', true);

		// First check that we can replicate the error with the old encryption method
		service.defaultEncryptionMethod_ = EncryptionService.METHOD_SJCL;
		const hasThrown = await checkThrowAsync(async () => await service.encryptString('🐶🐶🐶'.substr(0,5)));
		expect(hasThrown).toBe(true);

		// Now check that the new one fixes the problem
		service.defaultEncryptionMethod_ = EncryptionService.METHOD_SJCL_1A;
		const cipherText = await service.encryptString('🐶🐶🐶'.substr(0,5));
		const plainText = await service.decryptString(cipherText);
		expect(plainText).toBe('🐶🐶🐶'.substr(0,5));
	}));

	it('should check if a master key is loaded', (async () => {
		let masterKey = await service.generateMasterKey('123456');
		masterKey = await MasterKey.save(masterKey);

		await service.loadMasterKey(masterKey, '123456', true);

		expect(service.isMasterKeyLoaded(masterKey)).toBe(true);

		await msleep(1);

		// If the master key is modified afterwards it should report that it is
		// *not* loaded since it doesn't have this new version.
		masterKey = await MasterKey.save(masterKey);
		expect(service.isMasterKeyLoaded(masterKey)).toBe(false);
	}));
});
