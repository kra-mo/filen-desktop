import constants from "../../../constants.json"
import {
	getRandomArbitrary,
	Semaphore,
	nodeBufferToArrayBuffer,
	generateRandomString,
	chunkedPromiseAll,
	parseURLParamsSearch
} from "../helpers"
import {
	hashFn,
	encryptMetadata,
	encryptMetadataPublicKey,
	decryptFolderLinkKey,
	decryptFileMetadata,
	decryptFolderName,
	bufferToHash
} from "../crypto"
import db from "../db"
import { sendToAllPorts } from "../worker/ipc"
import { logout } from "../../windows/settings/account"
import striptags from "striptags"
import { isSyncLocationPaused } from "../worker/sync/sync.utils"
import { v4 as uuidv4 } from "uuid"
import packageJSON from "../../../../package.json"
import { RemoteFileMetadata } from "../../../types"

const https = window.require("https")
const log = window.require("electron-log")
const { ThrottleGroup } = window.require("speed-limiter")
const { Readable } = window.require("stream")
const progress = window.require("progress-stream")

export const createFolderSemaphore = new Semaphore(1)
export const throttleGroupUpload = new ThrottleGroup({
	rate: 1024 * 1024 * 1024
})
export const throttleGroupDownload = new ThrottleGroup({
	rate: 1024 * 1024 * 1024
})

const httpsAPIAgent = new https.Agent({
	keepAlive: true,
	maxSockets: constants.maxConcurrentAPIRequest,
	timeout: 3600000
})

const httpsUploadAgent = new https.Agent({
	keepAlive: true,
	maxSockets: constants.maxConcurrentUploads,
	timeout: 3600000
})

const httpsDownloadAgent = new https.Agent({
	keepAlive: true,
	maxSockets: constants.maxConcurrentDownloads,
	timeout: 3600000
})

const textEncoder = new TextEncoder()

export const getAPIServer = () => {
	return constants.apiServers[getRandomArbitrary(0, constants.apiServers.length - 1)]
}

export const getUploadServer = () => {
	return constants.uploadServers[getRandomArbitrary(0, constants.uploadServers.length - 1)]
}

export const getDownloadServer = () => {
	return constants.downloadServers[getRandomArbitrary(0, constants.downloadServers.length - 1)]
}

export const doAPIRequest = ({
	method = "POST",
	endpoint = "/v3/",
	data = {},
	timeout = 500000,
	includeRaw = false,
	apiKey = undefined
}): Promise<any> => {
	return new Promise((resolve, reject) => {
		bufferToHash(textEncoder.encode(JSON.stringify(typeof data !== "undefined" ? data : {})), "SHA-512")
			.then(checksum => {
				let currentTries = 0

				const doRequest = (): any => {
					if (!window.navigator.onLine) {
						return setTimeout(doRequest, constants.retryAPIRequestTimeout)
					}

					if (currentTries >= constants.maxRetryAPIRequest) {
						return reject(
							new Error(
								"Maximum retries (" +
									constants.maxRetryAPIRequest +
									") reached for API request: " +
									JSON.stringify({
										method,
										endpoint,
										data,
										timeout
									})
							)
						)
					}

					currentTries += 1

					const req = https.request(
						{
							method: method.toUpperCase(),
							hostname: "gateway.filen.io",
							path: endpoint,
							port: 443,
							timeout: 3600000,
							agent: httpsAPIAgent,
							headers: {
								"Content-Type": "application/json",
								"User-Agent":
									"filen-desktop/" + packageJSON.version + "-" + packageJSON.buildNumber + "-" + process.platform,
								Authorization: "Bearer " + apiKey,
								Checksum: checksum
							}
						},
						(response: any) => {
							if (response.statusCode !== 200) {
								log.error(
									new Error(
										"API response " +
											response.statusCode +
											", method: " +
											method.toUpperCase() +
											", endpoint: " +
											endpoint +
											", data: " +
											JSON.stringify(data)
									)
								)

								setTimeout(doRequest, constants.retryAPIRequestTimeout)

								return
							}

							const res: Buffer[] = []

							response.on("data", (chunk: Buffer) => {
								res.push(chunk)
							})

							response.on("end", () => {
								try {
									const str = Buffer.concat(res).toString()
									const obj = JSON.parse(str)

									if (typeof obj.code === "string" && obj.code === "internal_error") {
										setTimeout(doRequest, constants.retryAPIRequestTimeout)

										return
									}

									if (includeRaw) {
										resolve({
											data: obj,
											raw: str
										})

										return
									}

									resolve(obj)
								} catch (e) {
									log.error(e)

									reject(e)
								}
							})
						}
					)

					req.on("error", (err: any) => {
						log.error(err)

						setTimeout(doRequest, constants.retryAPIRequestTimeout)
					})

					req.on("timeout", () => {
						log.error("API request timed out")

						req.destroy()

						setTimeout(doRequest, constants.retryAPIRequestTimeout)
					})

					if (method.toUpperCase() === "POST") {
						req.write(JSON.stringify(data))
					}

					req.end()
				}

				doRequest()
			})
			.catch(reject)
	})
}

export const apiRequest = async ({
	method = "POST",
	endpoint,
	data,
	apiKey,
	includeRaw = false
}: {
	method: string
	endpoint: string
	data?: any
	apiKey?: string | null | undefined
	includeRaw?: boolean
}): Promise<any> => {
	const dbAPIKey = typeof apiKey === "string" && apiKey.length === 64 ? apiKey : await db.get("apiKey")
	const response = await doAPIRequest({ method, endpoint, data, apiKey: dbAPIKey, includeRaw })

	if (typeof response === "object") {
		if (typeof response.code === "string" && typeof response.message === "string") {
			if (
				response.message.toLowerCase().indexOf("api key not found") !== -1 ||
				response.message.toLowerCase().indexOf("invalid api key") !== -1 ||
				response.code === "api_key_not_found"
			) {
				logout().catch(console.error)

				throw new Error("Session invalidated")
			}
		}
	}

	return response
}

export const authInfo = async ({ email }: { email: string }): Promise<any> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/auth/info",
		data: {
			email
		}
	})

	if (!response.status) {
		throw new Error(response.message)
	}

	return response.data
}

export const login = async ({
	email,
	password,
	twoFactorCode,
	authVersion
}: {
	email: string
	password: string
	twoFactorCode: string | number
	authVersion: number
}): Promise<any> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/login",
		data: {
			email,
			password,
			twoFactorCode,
			authVersion
		}
	})

	if (!response.status) {
		throw new Error(response.message + ": " + response.code)
	}

	return response.data
}

export const userInfo = async (passedApiKey?: string): Promise<any> => {
	const apiKey = passedApiKey ? passedApiKey : await db.get("apiKey")
	const response = await apiRequest({
		method: "GET",
		endpoint: "/v3/user/info",
		apiKey
	})

	if (!response.status) {
		throw new Error(response.message)
	}

	return response.data
}

export const baseFolder = async (): Promise<string> => {
	const response = await apiRequest({
		method: "GET",
		endpoint: "/v3/user/baseFolder"
	})

	if (!response.status) {
		throw new Error(response.message)
	}

	return response.data.uuid
}

export const folderContent = async (uuid: string): Promise<any> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/dir/content",
		data: {
			uuid
		}
	})

	if (!response.status) {
		throw new Error(response.message)
	}

	return response.data
}

export const folderPresent = async (uuid: string): Promise<any> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/dir/present",
		data: {
			uuid
		}
	})

	if (!response.status) {
		throw new Error(response.message)
	}

	return response.data
}

export const filePresent = async (uuid: string): Promise<any> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/file/present",
		data: {
			uuid
		}
	})

	if (!response.status) {
		throw new Error(response.message)
	}

	return response.data
}

export const dirTree = async ({
	uuid,
	deviceId,
	skipCache = false,
	includeRaw = false
}: {
	uuid: string
	deviceId: string
	skipCache?: boolean
	includeRaw?: boolean
}): Promise<{ data: any; raw: string }> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/dir/tree",
		data: {
			uuid,
			deviceId,
			skipCache: skipCache ? 1 : 0
		},
		includeRaw
	})

	if (includeRaw) {
		if (!response.data.status) {
			throw new Error(response.data.message)
		}

		return { data: response.data.data, raw: response.raw }
	}

	if (!response.status) {
		throw new Error(response.message)
	}

	return response.data
}

export const createFolder = async ({ uuid, name, parent }: { uuid: string; name: string; parent: string }): Promise<string> => {
	await createFolderSemaphore.acquire()

	try {
		const nameHashed = hashFn(name.toLowerCase())
		const masterKeys = await db.get("masterKeys")
		const encrypted = await encryptMetadata(JSON.stringify({ name }), masterKeys[masterKeys.length - 1])
		const response = await apiRequest({
			method: "POST",
			endpoint: "/v3/dir/create",
			data: {
				uuid,
				name: encrypted,
				nameHashed,
				parent
			}
		})

		if (!response.status) {
			if (typeof response.data !== "undefined" && typeof response.data.existsUUID !== "undefined") {
				createFolderSemaphore.release()

				return response.data.existsUUID
			}

			throw new Error(response.message)
		}

		await checkIfItemParentIsShared({
			type: "folder",
			parent,
			metaData: {
				uuid,
				name
			}
		})

		createFolderSemaphore.release()

		return uuid
	} catch (e) {
		createFolderSemaphore.release()

		throw e
	}
}

export const fileExists = async ({ name, parent }: { name: string; parent: string }): Promise<{ exists: boolean; existsUUID: string }> => {
	const nameHashed = hashFn(name.toLowerCase())
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/file/exists",
		data: {
			parent,
			nameHashed
		}
	})

	if (!response.status) {
		throw new Error(response.message)
	}

	return {
		exists: response.data.exists,
		existsUUID: response.data.uuid
	}
}

export const folderExists = async ({
	name,
	parent
}: {
	name: string
	parent: string
}): Promise<{ exists: boolean; existsUUID: string }> => {
	const nameHashed = hashFn(name.toLowerCase())
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/dir/exists",
		data: {
			parent,
			nameHashed
		}
	})

	if (!response.status) {
		throw new Error(response.message)
	}

	return {
		exists: response.data.exists,
		existsUUID: response.data.uuid
	}
}

export const isSharingFolder = async (uuid: string): Promise<{ sharing: boolean; users: any }> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/dir/shared",
		data: {
			uuid
		}
	})

	if (!response.status) {
		throw new Error(response.message)
	}

	return {
		sharing: response.data.sharing,
		users: response.data.users
	}
}

export const isPublicLinkingFolder = async (uuid: string): Promise<{ linking: boolean; links: any }> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/dir/linked",
		data: {
			uuid
		}
	})

	if (!response.status) {
		throw new Error(response.message)
	}

	return {
		linking: response.data.link,
		links: response.data.links
	}
}

export const addItemToPublicLink = async (data: {
	uuid: string
	parent: string
	linkUUID: string
	type: string
	metadata: string
	key: string
	expiration: string
}): Promise<void> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/dir/link/add",
		data
	})

	if (!response.status) {
		throw new Error(response.message)
	}
}

export const shareItem = async (data: { uuid: string; parent: string; email: string; type: string; metadata: string }): Promise<void> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/item/share",
		data
	})

	if (!response.status) {
		throw new Error(response.message)
	}
}

export const isSharingItem = async (uuid: string): Promise<{ sharing: boolean; users: any }> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/item/shared",
		data: {
			uuid
		}
	})

	if (!response.status) {
		throw new Error(response.message)
	}

	return {
		sharing: response.data.sharing,
		users: response.data.users
	}
}

export const isItemInPublicLink = async (uuid: string): Promise<{ linking: boolean; links: any }> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/item/linked",
		data: {
			uuid
		}
	})

	if (!response.status) {
		throw new Error(response.message)
	}

	return {
		linking: response.data.link,
		links: response.data.links
	}
}

export const renameItemInPublicLink = async (data: { uuid: string; linkUUID: string; metadata: string }): Promise<void> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/item/linked/rename",
		data
	})

	if (!response.status) {
		throw new Error(response.message)
	}
}

export const renameSharedItem = async (data: { uuid: string; receiverId: number; metadata: string }): Promise<void> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/item/shared/rename",
		data
	})

	if (!response.status) {
		throw new Error(response.message)
	}
}

export const getFolderContents = async (uuid: string): Promise<any> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/dir/download",
		data: {
			uuid
		}
	})

	if (!response.status) {
		throw new Error(response.message)
	}

	return response.data
}

export const checkIfItemParentIsShared = ({ type, parent, metaData }: { type: string; parent: string; metaData: any }): Promise<any> => {
	return new Promise((resolve, reject) => {
		db.get("apiKey")
			.then(apiKey => {
				db.get("masterKeys")
					.then(masterKeys => {
						let shareCheckDone = false
						let linkCheckDone = false
						let resolved = false
						let doneInterval: any = undefined

						const done = () => {
							if (shareCheckDone && linkCheckDone) {
								clearInterval(doneInterval)

								if (!resolved) {
									resolved = true

									resolve(true)
								}

								return true
							}

							return false
						}

						doneInterval = setInterval(done, 100)

						isSharingFolder(parent)
							.then((data: any) => {
								if (!data.sharing) {
									shareCheckDone = true

									return done()
								}

								const totalUsers = data.users.length

								if (type == "file") {
									let doneUsers = 0

									const doneSharing = () => {
										doneUsers += 1

										if (doneUsers >= totalUsers) {
											shareCheckDone = true

											done()
										}

										return true
									}

									for (let i = 0; i < totalUsers; i++) {
										const user = data.users[i]
										const itemMetadata = JSON.stringify({
											name: metaData.name,
											size: metaData.size,
											mime: metaData.mime,
											key: metaData.key,
											lastModified: metaData.lastModified
										})

										encryptMetadataPublicKey({
											data: itemMetadata,
											publicKey: user.publicKey
										})
											.then(encrypted => {
												shareItem({
													uuid: metaData.uuid,
													parent,
													email: user.email,
													type,
													metadata: encrypted
												})
													.then(() => {
														return doneSharing()
													})
													.catch(err => {
														console.log(err)

														return doneSharing()
													})
											})
											.catch(err => {
												console.log(err)

												return doneSharing()
											})
									}
								} else {
									getFolderContents(metaData.uuid)
										.then(async (contents: any) => {
											const itemsToShare = []

											itemsToShare.push({
												uuid: metaData.uuid,
												parent,
												metadata: metaData.name,
												type: "folder"
											})

											const files = contents.files
											const folders = contents.folders

											for (let i = 0; i < files.length; i++) {
												const decrypted = await decryptFileMetadata(files[i].metadata, masterKeys)

												if (typeof decrypted == "object") {
													if (typeof decrypted.name == "string") {
														decrypted.name = striptags(decrypted.name)

														if (decrypted.name.length > 0) {
															itemsToShare.push({
																uuid: files[i].uuid,
																parent: files[i].parent,
																metadata: {
																	name: decrypted.name,
																	size: decrypted.size,
																	mime: striptags(decrypted.mime),
																	key: decrypted.key,
																	lastModified: decrypted.lastModified
																},
																type: "file"
															})
														}
													}
												}
											}

											for (let i = 0; i < folders.length; i++) {
												try {
													var decrypted: any = striptags(await decryptFolderName(folders[i].name, masterKeys))
												} catch (e) {
													//console.log(e)
												}

												if (typeof decrypted == "string") {
													if (decrypted.length > 0) {
														if (folders[i].uuid !== metaData.uuid && folders[i].parent !== "base") {
															itemsToShare.push({
																uuid: folders[i].uuid,
																parent: i == 0 ? "none" : folders[i].parent,
																metadata: decrypted,
																type: "folder"
															})
														}
													}
												}
											}

											let itemsShared = 0

											const doneSharingItem = () => {
												itemsShared += 1

												if (itemsShared >= itemsToShare.length * totalUsers) {
													shareCheckDone = true

													done()
												}

												return true
											}

											for (let i = 0; i < itemsToShare.length; i++) {
												const itemToShare = itemsToShare[i]

												for (let x = 0; x < totalUsers; x++) {
													const user = data.users[x]
													let itemMetadata = ""

													if (itemToShare.type == "file") {
														itemMetadata = JSON.stringify({
															name: itemToShare.metadata.name,
															size: itemToShare.metadata.size,
															mime: itemToShare.metadata.mime,
															key: itemToShare.metadata.key,
															lastModified: itemToShare.metadata.lastModified
														})
													} else {
														itemMetadata = JSON.stringify({
															name: itemToShare.metadata
														})
													}

													encryptMetadataPublicKey({
														data: itemMetadata,
														publicKey: user.publicKey
													})
														.then(encrypted => {
															shareItem({
																uuid: itemToShare.uuid,
																parent: itemToShare.parent,
																email: user.email,
																type: itemToShare.type,
																metadata: encrypted
															})
																.then(() => {
																	return doneSharingItem()
																})
																.catch(err => {
																	console.log(err)

																	return doneSharingItem()
																})
														})
														.catch(err => {
															console.log(err)

															return doneSharingItem()
														})
												}
											}
										})
										.catch(err => {
											console.log(err)

											shareCheckDone = true

											return done()
										})
								}
							})
							.catch(err => {
								console.log(err)

								shareCheckDone = true

								return done()
							})

						isPublicLinkingFolder(parent)
							.then(async (data: any) => {
								if (!data.linking) {
									linkCheckDone = true

									return done()
								}

								const totalLinks = data.links.length

								if (type == "file") {
									let linksDone = 0

									const doneLinking = () => {
										linksDone += 1

										if (linksDone >= totalLinks) {
											linkCheckDone = true

											done()
										}

										return true
									}

									for (let i = 0; i < totalLinks; i++) {
										const link = data.links[i]

										try {
											var key: any = await decryptFolderLinkKey(link.linkKey, masterKeys)
										} catch (e) {
											//console.log(e)
										}

										if (typeof key == "string") {
											if (key.length > 0) {
												try {
													var encrypted: any = await encryptMetadata(
														JSON.stringify({
															name: metaData.name,
															size: metaData.size,
															mime: metaData.mime,
															key: metaData.key,
															lastModified: metaData.lastModified
														}),
														key
													)
												} catch (e) {
													//console.log(e)
												}

												if (typeof encrypted == "string") {
													if (encrypted.length > 0) {
														addItemToPublicLink({
															uuid: metaData.uuid,
															parent,
															linkUUID: link.linkUUID,
															type,
															metadata: encrypted,
															key: link.linkKey,
															expiration: "never"
														})
															.then(() => {
																return doneLinking()
															})
															.catch(err => {
																console.log(err)

																return doneLinking()
															})
													} else {
														doneLinking()
													}
												} else {
													doneLinking()
												}
											} else {
												doneLinking()
											}
										} else {
											doneLinking()
										}
									}
								} else {
									getFolderContents(metaData.uuid)
										.then(async (contents: any) => {
											const itemsToLink = []

											itemsToLink.push({
												uuid: metaData.uuid,
												parent,
												metadata: metaData.name,
												type: "folder"
											})

											const files = contents.files
											const folders = contents.folders

											for (let i = 0; i < files.length; i++) {
												const decrypted = await decryptFileMetadata(files[i].metadata, masterKeys)

												if (typeof decrypted == "object") {
													if (typeof decrypted.name == "string") {
														decrypted.name = striptags(decrypted.name)

														if (decrypted.name.length > 0) {
															itemsToLink.push({
																uuid: files[i].uuid,
																parent: files[i].parent,
																metadata: {
																	name: decrypted.name,
																	size: decrypted.size,
																	mime: striptags(decrypted.mime),
																	key: decrypted.key,
																	lastModified: decrypted.lastModified
																},
																type: "file"
															})
														}
													}
												}
											}

											for (let i = 0; i < folders.length; i++) {
												try {
													var decrypted: any = striptags(await decryptFolderName(folders[i].name, masterKeys))
												} catch (e) {
													//console.log(e)
												}

												if (typeof decrypted == "string") {
													if (decrypted.length > 0) {
														if (folders[i].uuid !== metaData.uuid && folders[i].parent !== "base") {
															itemsToLink.push({
																uuid: folders[i].uuid,
																parent: i == 0 ? "none" : folders[i].parent,
																metadata: decrypted,
																type: "folder"
															})
														}
													}
												}
											}

											let itemsLinked = 0

											const itemLinked = () => {
												itemsLinked += 1

												if (itemsLinked >= itemsToLink.length * totalLinks) {
													linkCheckDone = true

													done()
												}

												return true
											}

											for (let i = 0; i < itemsToLink.length; i++) {
												const itemToLink = itemsToLink[i]

												for (let x = 0; x < totalLinks; x++) {
													const link = data.links[x]
													const key = await decryptFolderLinkKey(link.linkKey, masterKeys)

													if (typeof key == "string") {
														if (key.length > 0) {
															let itemMetadata = ""

															if (itemToLink.type == "file") {
																itemMetadata = JSON.stringify({
																	name: itemToLink.metadata.name,
																	size: itemToLink.metadata.size,
																	mime: itemToLink.metadata.mime,
																	key: itemToLink.metadata.key,
																	lastModified: itemToLink.metadata.lastModified
																})
															} else {
																itemMetadata = JSON.stringify({
																	name: itemToLink.metadata
																})
															}

															try {
																var encrypted: any = await encryptMetadata(itemMetadata, key)
															} catch (e) {
																//console.log(e)
															}

															if (typeof encrypted == "string") {
																if (encrypted.length > 0) {
																	addItemToPublicLink({
																		uuid: itemToLink.uuid,
																		parent: itemToLink.parent,
																		linkUUID: link.linkUUID,
																		type: itemToLink.type,
																		metadata: encrypted,
																		key: link.linkKey,
																		expiration: "never"
																	})
																		.then(() => {
																			return itemLinked()
																		})
																		.catch(err => {
																			console.log(err)

																			return itemLinked()
																		})
																} else {
																	itemLinked()
																}
															} else {
																itemLinked()
															}
														} else {
															itemLinked()
														}
													} else {
														itemLinked()
													}
												}
											}
										})
										.catch(err => {
											console.log(err)

											linkCheckDone = true

											return done()
										})
								}
							})
							.catch(err => {
								console.log(err)

								linkCheckDone = true

								return done()
							})
					})
					.catch(reject)
			})
			.catch(reject)
	})
}

export const checkIfItemIsSharedForRename = ({ type, uuid, metaData }: { type: string; uuid: string; metaData: any }): Promise<any> => {
	return new Promise((resolve, reject) => {
		db.get("apiKey")
			.then(apiKey => {
				db.get("masterKeys")
					.then(masterKeys => {
						let shareCheckDone = false
						let linkCheckDone = false
						let resolved = false
						let doneInterval: any = undefined

						const done = () => {
							if (shareCheckDone && linkCheckDone) {
								clearInterval(doneInterval)

								if (!resolved) {
									resolved = true

									resolve(true)
								}

								return true
							}

							return false
						}

						doneInterval = setInterval(done, 100)

						isSharingItem(uuid)
							.then((data: any) => {
								if (!data.sharing) {
									shareCheckDone = true

									return done()
								}

								const totalUsers = data.users.length
								let doneUsers = 0

								const doneSharing = () => {
									doneUsers += 1

									if (doneUsers >= totalUsers) {
										shareCheckDone = true

										done()
									}

									return true
								}

								for (let i = 0; i < totalUsers; i++) {
									const user = data.users[i]
									let itemMetadata = ""

									if (type == "file") {
										itemMetadata = JSON.stringify({
											name: metaData.name,
											size: metaData.size,
											mime: metaData.mime,
											key: metaData.key,
											lastModified: metaData.lastModified
										})
									} else {
										itemMetadata = JSON.stringify({
											name: metaData.name
										})
									}

									encryptMetadataPublicKey({
										data: itemMetadata,
										publicKey: user.publicKey
									})
										.then(encrypted => {
											renameSharedItem({
												uuid,
												receiverId: user.id,
												metadata: encrypted
											})
												.then(() => {
													return doneSharing()
												})
												.catch(err => {
													console.log(err)

													return doneSharing()
												})
										})
										.catch(err => {
											console.log(err)

											return doneSharing()
										})
								}
							})
							.catch(err => {
								console.log(err)

								shareCheckDone = true

								return done()
							})

						isItemInPublicLink(uuid)
							.then((data: any) => {
								if (!data.linking) {
									linkCheckDone = true

									return done()
								}

								const totalLinks = data.links.length
								let linksDone = 0

								const doneLinking = () => {
									linksDone += 1

									if (linksDone >= totalLinks) {
										linkCheckDone = true

										done()
									}

									return true
								}

								for (let i = 0; i < totalLinks; i++) {
									const link = data.links[i]

									decryptFolderLinkKey(link.linkKey, masterKeys)
										.then(key => {
											let itemMetadata = ""

											if (type == "file") {
												itemMetadata = JSON.stringify({
													name: metaData.name,
													size: metaData.size,
													mime: metaData.mime,
													key: metaData.key,
													lastModified: metaData.lastModified
												})
											} else {
												itemMetadata = JSON.stringify({
													name: metaData.name
												})
											}

											encryptMetadata(itemMetadata, key)
												.then(encrypted => {
													renameItemInPublicLink({
														uuid,
														linkUUID: link.linkUUID,
														metadata: encrypted
													})
														.then(() => {
															return doneLinking()
														})
														.catch(err => {
															console.log(err)

															return doneLinking()
														})
												})
												.catch(err => {
													console.log(err)

													return doneLinking()
												})
										})
										.catch(err => {
											console.log(err)

											return doneLinking()
										})
								}
							})
							.catch(err => {
								console.log(err)

								linkCheckDone = true

								return done()
							})
					})
					.catch(reject)
			})
			.catch(reject)
	})
}

export const uploadChunk = ({
	queryParams,
	data,
	from = "sync",
	location = undefined
}: {
	queryParams: any
	data: Uint8Array
	from: string
	location?: any
}): Promise<any> => {
	return new Promise((resolve, reject) => {
		chunkedPromiseAll([db.get("networkingSettings"), db.get("maxStorageReached"), db.get("apiKey"), bufferToHash(data, "SHA-512")])
			.then(async ([networkingSettings, maxStorageReached, apiKey, chunkHash]) => {
				if (maxStorageReached) {
					return reject(new Error("Max storage reached"))
				}

				await new Promise(resolve => {
					const getPausedStatus = () => {
						if (from == "sync") {
							if (typeof location !== "undefined" && typeof location.uuid == "string") {
								chunkedPromiseAll([db.get("paused"), isSyncLocationPaused(location.uuid)])
									.then(([paused, locationPaused]) => {
										if (paused || locationPaused) {
											return setTimeout(getPausedStatus, 1000)
										}

										return resolve(true)
									})
									.catch(err => {
										log.error(err)

										return setTimeout(getPausedStatus, 1000)
									})
							} else {
								db.get("paused")
									.then(paused => {
										if (paused) {
											return setTimeout(getPausedStatus, 1000)
										}

										return resolve(true)
									})
									.catch(err => {
										log.error(err)

										return setTimeout(getPausedStatus, 1000)
									})
							}
						} else {
							db.get(
								from.indexOf("download") !== -1
									? "downloadPaused"
									: from.indexOf("upload") !== -1
									? "uploadPaused"
									: "paused"
							)
								.then(paused => {
									if (paused) {
										return setTimeout(getPausedStatus, 1000)
									}

									return resolve(true)
								})
								.catch(err => {
									log.error(err)

									return setTimeout(getPausedStatus, 1000)
								})
						}
					}

					return getPausedStatus()
				})

				queryParams = queryParams + "&hash=" + encodeURIComponent(chunkHash)

				const urlParams = new URLSearchParams(queryParams)
				const uuid = urlParams.get("uuid") || ""
				const parsedURLParams = parseURLParamsSearch(urlParams)

				bufferToHash(textEncoder.encode(JSON.stringify(parsedURLParams)), "SHA-512")
					.then(checksum => {
						let bps = 122070 * 1024

						if (networkingSettings !== null && typeof networkingSettings == "object" && from == "sync") {
							if (typeof networkingSettings.uploadKbps !== "undefined" && networkingSettings.uploadKbps > 0) {
								bps = Math.floor(networkingSettings.uploadKbps * 1024)
							}
						}

						throttleGroupUpload.setRate(bps)

						let currentTries = 0

						const doRequest = async (): Promise<any> => {
							if (!window.navigator.onLine) {
								setTimeout(doRequest, constants.retryUploadTimeout)

								return
							}

							if (currentTries >= constants.maxRetryUpload) {
								reject(new Error("Max retries reached for upload " + uuid))

								return
							}

							currentTries += 1

							let lastBytes = 0
							const throttle = throttleGroupUpload.throttle()

							const calcProgress = (written: number) => {
								let bytes = written

								if (lastBytes === 0) {
									lastBytes = written
								} else {
									bytes = Math.floor(written - lastBytes)
									lastBytes = written
								}

								sendToAllPorts({
									type: from == "sync" ? "uploadProgress" : "uploadProgressSeperate",
									data: {
										uuid,
										bytes,
										from
									}
								})
							}

							const req = https.request(
								{
									method: "POST",
									hostname: "ingest.filen.io",
									path: "/v3/upload?" + queryParams,
									port: 443,
									timeout: 3600000,
									agent: httpsUploadAgent,
									headers: {
										"User-Agent":
											"filen-desktop/" + packageJSON.version + "-" + packageJSON.buildNumber + "-" + process.platform,
										Authorization: "Bearer " + apiKey,
										"Content-Type": "application/x-www-form-urlencoded",
										Checksum: checksum
									}
								},
								(response: any) => {
									if (response.statusCode !== 200) {
										log.error(new Error("Upload failed, status code: " + response.statusCode))

										throttle.destroy()

										setTimeout(doRequest, constants.retryUploadTimeout)

										return
									}

									const res: Buffer[] = []

									response.on("data", (chunk: Buffer) => {
										res.push(chunk)
									})

									response.on("end", () => {
										try {
											const obj = JSON.parse(Buffer.concat(res).toString())

											if (!obj.status) {
												if (obj.message.toLowerCase().indexOf("storage") !== -1) {
													db.set("paused", true).catch(log.error)
													db.set("maxStorageReached", true).catch(log.error)
												}

												throttle.destroy()

												reject(obj.message)

												return
											}

											resolve(obj)
										} catch (e) {
											reject(e)
										}
									})
								}
							)

							req.on("error", (err: any) => {
								log.error(err)

								throttle.destroy()

								reject(err)
							})

							req.on("timeout", () => {
								log.error("Upload request timed out")

								throttle.destroy()
								req.destroy()

								reject(new Error("Upload request timed out"))
							})

							const str = progress({
								length: data.byteLength,
								time: 100
							})

							str.on("progress", (info: any) => calcProgress(info.transferred))

							Readable.from([data])
								.pipe(str.on("end", () => str.destroy()))
								.pipe(throttle.on("end", () => throttle.destroy()))
								.pipe(req)
						}

						doRequest()
					})
					.catch(reject)
			})
			.catch(reject)
	})
}

export const markUploadAsDone = async (data: {
	uuid: string
	name: string
	nameHashed: string
	size: string
	chunks: number
	mime: string
	rm: string
	metadata: string
	version: number
	uploadKey: string
}): Promise<{ chunks: number; size: number }> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/upload/done",
		data
	})

	if (!response.status) {
		throw new Error(response.message)
	}

	return response.data
}

export const downloadChunk = ({
	region,
	bucket,
	uuid,
	index,
	from = "sync",
	location = undefined
}: {
	region: string
	bucket: string
	uuid: string
	index: number
	from: string
	location?: any
}): Promise<any> => {
	return new Promise((resolve, reject) => {
		db.get("networkingSettings")
			.then(async networkingSettings => {
				await new Promise(resolve => {
					const getPausedStatus = () => {
						if (from == "sync") {
							if (typeof location !== "undefined" && typeof location.uuid == "string") {
								chunkedPromiseAll([db.get("paused"), isSyncLocationPaused(location.uuid)])
									.then(([paused, locationPaused]) => {
										if (paused || locationPaused) {
											return setTimeout(getPausedStatus, 1000)
										}

										return resolve(true)
									})
									.catch(err => {
										log.error(err)

										return setTimeout(getPausedStatus, 1000)
									})
							} else {
								db.get("paused")
									.then(paused => {
										if (paused) {
											return setTimeout(getPausedStatus, 1000)
										}

										return resolve(true)
									})
									.catch(err => {
										log.error(err)

										return setTimeout(getPausedStatus, 1000)
									})
							}
						} else {
							db.get(
								from.indexOf("download") !== -1
									? "downloadPaused"
									: from.indexOf("upload") !== -1
									? "uploadPaused"
									: "paused"
							)
								.then(paused => {
									if (paused) {
										return setTimeout(getPausedStatus, 1000)
									}

									return resolve(true)
								})
								.catch(err => {
									log.error(err)

									return setTimeout(getPausedStatus, 1000)
								})
						}
					}

					return getPausedStatus()
				})

				let bps = 122070 * 1024

				if (networkingSettings !== null && typeof networkingSettings == "object" && from == "sync") {
					if (typeof networkingSettings.downloadKbps !== "undefined" && networkingSettings.downloadKbps > 0) {
						bps = Math.floor(networkingSettings.downloadKbps * 1024)
					}
				}

				throttleGroupDownload.setRate(bps)

				let currentTries = 0

				const doRequest = async (): Promise<any> => {
					if (!window.navigator.onLine) {
						return setTimeout(doRequest, constants.retryDownloadTimeout)
					}

					if (currentTries >= constants.maxRetryDownload) {
						return reject(new Error("Max retries reached for /" + region + "/" + bucket + "/" + uuid + "/" + index))
					}

					const throttle = throttleGroupDownload.throttle()

					currentTries += 1

					const request = https.request({
						host: "down.filen.io",
						port: 443,
						path: "/" + region + "/" + bucket + "/" + uuid + "/" + index,
						method: "GET",
						agent: httpsDownloadAgent,
						timeout: 86400000,
						headers: {
							"User-Agent": "filen-desktop/" + packageJSON.version + "-" + packageJSON.buildNumber + "-" + process.platform
						}
					})

					request.on("response", (response: any) => {
						if (response.statusCode !== 200) {
							log.error("Invalid http statuscode: " + response.statusCode)

							throttle.destroy()

							return setTimeout(doRequest, constants.retryDownloadTimeout)
						}

						const res: Buffer[] = []

						response.on("error", (err: Error) => {
							log.error(err)

							throttle.destroy()

							return setTimeout(doRequest, constants.retryDownloadTimeout)
						})

						response
							.pipe(throttle)
							.on("data", (chunk: Buffer) => {
								res.push(chunk)

								sendToAllPorts({
									type: from == "sync" ? "downloadProgress" : "downloadProgressSeperate",
									data: {
										uuid,
										bytes: chunk.length,
										from
									}
								})
							})
							.on("end", () => {
								try {
									resolve(nodeBufferToArrayBuffer(Buffer.concat(res)))
								} catch (e) {
									reject(e)
								}

								throttle.destroy()

								return true
							})
					})

					request.on("error", (err: Error) => {
						log.error(err)

						throttle.destroy()

						return setTimeout(doRequest, constants.retryDownloadTimeout)
					})

					request.on("timeout", () => {
						log.error("Download request timed out")

						throttle.destroy()
						request.destroy()

						return setTimeout(doRequest, constants.retryDownloadTimeout)
					})

					request.end()
				}

				return doRequest()
			})
			.catch(reject)
	})
}

export const trashItem = async ({ type, uuid }: { type: string; uuid: string }): Promise<void> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: type == "folder" ? "/v3/dir/trash" : "/v3/file/trash",
		data: {
			uuid
		}
	})

	if (!response.status) {
		if (["folder_not_found", "file_not_found"].includes(response.code)) {
			return
		}

		throw new Error(response.message)
	}
}

export const moveFile = async ({ file, parent }: { file: any; parent: string }): Promise<void> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/file/move",
		data: {
			uuid: file.uuid,
			to: parent
		}
	})

	if (!response.status) {
		if (["file_not_found"].includes(response.code)) {
			return
		}

		throw new Error(response.message)
	}

	await checkIfItemParentIsShared({
		type: "file",
		parent,
		metaData: {
			uuid: file.uuid,
			name: file.name,
			size: file.size,
			mime: file.mime,
			key: file.key,
			lastModified: file.lastModified
		}
	})
}

export const moveFolder = async ({ folder, parent }: { folder: any; parent: string }): Promise<void> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/dir/move",
		data: {
			uuid: folder.uuid,
			to: parent
		}
	})

	if (!response.status) {
		if (["folder_not_found"].includes(response.code)) {
			return
		}

		throw new Error(response.message)
	}

	await checkIfItemParentIsShared({
		type: "folder",
		parent,
		metaData: {
			name: folder.name,
			uuid: folder.uuid
		}
	})
}

export const renameFile = async ({ file, name }: { file: any; name: string }): Promise<void> => {
	const nameHashed = hashFn(name.toLowerCase())
	const masterKeys = await db.get("masterKeys")
	const [encrypted, encryptedName] = await chunkedPromiseAll([
		encryptMetadata(
			JSON.stringify({
				name,
				size: file.size,
				mime: file.mime,
				key: file.key,
				lastModified: file.lastModified
			}),
			masterKeys[masterKeys.length - 1]
		),
		encryptMetadata(name, file.key)
	])

	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/file/rename",
		data: {
			uuid: file.uuid,
			name: encryptedName,
			nameHashed,
			metadata: encrypted
		}
	})

	if (!response.status) {
		if (["file_not_found"].includes(response.code)) {
			return
		}

		throw new Error(response.message)
	}

	await checkIfItemIsSharedForRename({
		type: "file",
		uuid: file.uuid,
		metaData: {
			name,
			size: file.size,
			mime: file.mime,
			key: file.key,
			lastModified: file.lastModified
		}
	})
}

export const renameFolder = async ({ folder, name }: { folder: any; name: string }): Promise<void> => {
	const nameHashed = hashFn(name.toLowerCase())
	const masterKeys = await db.get("masterKeys")
	const encrypted = await encryptMetadata(JSON.stringify({ name }), masterKeys[masterKeys.length - 1])
	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/dir/rename",
		data: {
			uuid: folder.uuid,
			name: encrypted,
			nameHashed
		}
	})

	if (!response.status) {
		if (["folder_not_found"].includes(response.code)) {
			return
		}

		throw new Error(response.message)
	}

	await checkIfItemIsSharedForRename({
		type: "folder",
		uuid: folder.uuid,
		metaData: {
			name
		}
	})
}

export const itemPublicLinkInfo = async (uuid: string, type: "folder" | "file"): Promise<any> => {
	const response = await apiRequest({
		method: "POST",
		endpoint: type == "file" ? "/v3/file/link/status" : "/v3/dir/link/status",
		data:
			type == "file"
				? {
						uuid
				  }
				: {
						uuid
				  }
	})

	if (!response.status) {
		throw new Error(response.message)
	}

	return response.data
}

export const enableItemPublicLink = async (
	uuid: string,
	type: "folder" | "file",
	progressCallback?: (current: number, total: number) => any
): Promise<void> => {
	if (type == "folder") {
		throw new Error("Not implemented")
	} else {
		const linkUUID = uuidv4()
		const response = await apiRequest({
			method: "POST",
			endpoint: "/v3/file/link/edit",
			data: {
				uuid: linkUUID,
				fileUUID: uuid,
				expiration: "never",
				password: "empty",
				passwordHashed: hashFn("empty"),
				salt: generateRandomString(32),
				downloadBtn: true,
				type: "enable"
			}
		})

		if (typeof progressCallback == "function") {
			progressCallback(1, 1)
		}

		if (!response.status) {
			throw new Error(response.message)
		}
	}
}

export const disableItemPublicLink = async (uuid: string, type: "folder" | "file", linkUUID: string): Promise<void> => {
	if (type == "file") {
		if (typeof linkUUID !== "string" || linkUUID.length < 32) {
			throw new Error("Invalid linkUUID")
		}

		const response = await apiRequest({
			method: "POST",
			endpoint: "/v3/file/link/edit",
			data: {
				uuid: linkUUID,
				fileUUID: uuid,
				expiration: "never",
				password: "empty",
				passwordHashed: hashFn("empty"),
				salt: generateRandomString(32),
				downloadBtn: true,
				type: "disable"
			}
		})

		if (!response.status) {
			throw new Error(response.message)
		}
	} else {
		const response = await apiRequest({
			method: "POST",
			endpoint: "/v3/dir/link/remove",
			data: {
				uuid
			}
		})

		if (!response.status) {
			throw new Error(response.message)
		}
	}
}

export const getFileMetadata = async (uuid: string): Promise<RemoteFileMetadata> => {
	const masterKeys = await db.get("masterKeys")

	if (!Array.isArray(masterKeys)) {
		throw new Error("Invalid master keys")
	}

	const response = await apiRequest({
		method: "POST",
		endpoint: "/v3/file",
		data: {
			uuid
		}
	})

	if (!response.status) {
		throw new Error(response.message + ": " + response.code)
	}

	return await decryptFileMetadata(response.data.metadata, masterKeys)
}
