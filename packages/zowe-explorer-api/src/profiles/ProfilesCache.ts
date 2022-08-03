/*
 * This program and the accompanying materials are made available under the terms of the *
 * Eclipse Public License v2.0 which accompanies this distribution, and is available at *
 * https://www.eclipse.org/legal/epl-v20.html                                      *
 *                                                                                 *
 * SPDX-License-Identifier: EPL-2.0                                                *
 *                                                                                 *
 * Copyright Contributors to the Zowe Project.                                     *
 *                                                                                 *
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { URL } from "url";

import * as zowe from "@zowe/cli";
import { ZoweExplorerApi } from "./ZoweExplorerApi";

// TODO: find a home for constants
export const CONTEXT_PREFIX = "_";
export const DEFAULT_PORT = 443;

export interface IUrlValidator {
    valid: boolean;
    protocol: string;
    host: string;
    port: number;
}

export interface IProfileValidation {
    status: string;
    name: string;
}

export interface IValidationSetting {
    name: string;
    setting: boolean;
}

export enum ValidProfileEnum {
    UNVERIFIED = 1,
    VALID = 0,
    INVALID = -1,
}

export function getZoweDir(): string {
    return zowe.getZoweDir();
}

export function getFullPath(anyPath: string): string {
    if (os.platform() === "win32") {
        return fs.realpathSync.native(anyPath);
    }
    return fs.realpathSync(anyPath);
}

export class ProfilesCache {
    public profilesForValidation: IProfileValidation[] = [];
    public profilesValidationSetting: IValidationSetting[] = [];
    public allProfiles: zowe.imperative.IProfileLoaded[] = [];
    protected allTypes: string[];
    protected allExternalTypes = new Set<string>();
    protected profilesByType = new Map<string, zowe.imperative.IProfileLoaded[]>();
    protected defaultProfileByType = new Map<string, zowe.imperative.IProfileLoaded>();
    protected profileManagerByType = new Map<string, zowe.imperative.CliProfileManager>();
    public constructor(protected log: zowe.imperative.Logger, protected cwd?: string) {
        this.cwd = cwd != null ? getFullPath(cwd) : undefined;
    }

    public async getProfileInfo(): Promise<zowe.imperative.ProfileInfo> {
        const mProfileInfo = new zowe.imperative.ProfileInfo("zowe");
        await mProfileInfo.readProfilesFromDisk({ projectDir: this.cwd });
        return mProfileInfo;
    }

    /**
     * Loads the named profile from allProfiles
     *
     * @param {string} name Name of Profile
     * @param {string} type Type of Profile, optional
     *
     * @returns {IProfileLoaded}
     */
    public loadNamedProfile(name: string, type?: string): zowe.imperative.IProfileLoaded {
        for (const profile of this.allProfiles) {
            if (profile.name === name && (type ? profile.type === type : true)) {
                return profile;
            }
        }
        throw new Error(`Zowe Explorer Profiles Cache error: Could not find profile named: ${name}.`);
    }

    /**
     * Updates profile in allProfiles array and if default updates defaultProfileByType
     *
     * @param {string} profileLoaded
     *
     * @returns {void}
     */
    public updateProfilesArrays(profileLoaded: zowe.imperative.IProfileLoaded): void {
        // update allProfiles array
        const promptedTypeIndex = this.allProfiles.findIndex(
            (profile) => profile.type === profileLoaded.type && profile.name === profileLoaded.name
        );
        this.allProfiles[promptedTypeIndex] = profileLoaded;
        // checks if default, if true update defaultProfileByType
        const defaultProf = this.defaultProfileByType.get(profileLoaded.type);
        if (defaultProf.name === profileLoaded.name) {
            this.defaultProfileByType.set(profileLoaded.type, profileLoaded);
        }
    }

    /**
     * This returns default profile by type from defaultProfileByType
     *
     * @param {string} type Name of Profile, defaults to "zosmf" if nothing passed.
     *
     * @returns {IProfileLoaded}
     */
    public getDefaultProfile(type = "zosmf"): zowe.imperative.IProfileLoaded {
        return this.defaultProfileByType.get(type);
    }

    /**
     * Gets default Profile attributes from imperative
     *
     * @param {ProfileInfo} mProfileInfo
     * @param {string} profileType Type of Profile, optional
     *
     * @returns {IProfAttrs}
     */
    public getDefaultConfigProfile(
        mProfileInfo: zowe.imperative.ProfileInfo,
        profileType: string
    ): zowe.imperative.IProfAttrs {
        return mProfileInfo.getDefaultProfile(profileType);
    }

    /**
     * Gets array of profiles by type
     *
     * @param {string} type Type of Profile, defaults to "zosmf" if nothing passed.
     *
     * @returns {IProfileLoaded[]}
     */
    public getProfiles(type = "zosmf"): zowe.imperative.IProfileLoaded[] {
        return this.profilesByType.get(type);
    }

    /**
     * Used for extenders to register with Zowe Explorer that do not need their
     * profile type in the existing MVS, USS, and JES
     *
     * @param {string} profileTypeName Type of Profile, defaults to "zosmf" if nothing passed.
     *
     * @returns {void}
     */
    public registerCustomProfilesType(profileTypeName: string): void {
        this.allExternalTypes.add(profileTypeName);
    }

    public async refresh(apiRegister?: ZoweExplorerApi.IApiRegisterClient): Promise<void> {
        this.allProfiles = [];
        let tmpAllProfiles: zowe.imperative.IProfileLoaded[] = [];
        this.allTypes = [];
        const mProfileInfo = await this.getProfileInfo();
        const allTypes = this.getAllProfileTypes(apiRegister.registeredApiTypes());
        allTypes.push("base");
        for (const type of allTypes) {
            // Step 1: Get all profiles for each registered type
            const profilesForType = mProfileInfo.getAllProfiles(type).filter((temp) => temp.profLoc.osLoc.length !== 0);
            if (profilesForType && profilesForType.length > 0) {
                for (const prof of profilesForType) {
                    // Step 2: Merge args for each profile
                    const profAttr = this.getMergedAttrs(mProfileInfo, prof);
                    // Work-around. TODO: Discuss with imperative team
                    const profileFix = this.getProfileLoaded(prof.profName, prof.profType, profAttr);
                    // set default for type
                    if (prof.isDefaultProfile) {
                        this.defaultProfileByType.set(type, profileFix);
                    }

                    // Step 3: Update allProfiles list
                    tmpAllProfiles.push(profileFix);
                }
                this.allProfiles.push(...tmpAllProfiles);
                this.profilesByType.set(type, tmpAllProfiles);
                tmpAllProfiles = [];
            }
            this.allTypes.push(type);
        }
        // check for proper merging of apiml tokens
        this.checkMergingConfigAllProfiles();
        while (this.profilesForValidation.length > 0) {
            this.profilesForValidation.pop();
        }
    }

    public validateAndParseUrl(newUrl: string): IUrlValidator {
        let url: URL;

        const validationResult: IUrlValidator = {
            valid: false,
            protocol: null,
            host: null,
            port: null,
        };

        try {
            url = new URL(newUrl);
        } catch (error) {
            return validationResult;
        }

        if (newUrl.includes(":443")) {
            validationResult.port = 443;
        } else {
            validationResult.port = Number(url.port);
        }

        validationResult.host = url.hostname;
        validationResult.valid = true;
        return validationResult;
    }

    /**
     * LOOK FOR A WAY TO GETSCHEMA OF CONFIG TOO
     * gets schema from /.zowe/profiles/profileType directory
     * used by Zowe Explorer for creation & update of v1 profiles
     * @param profileType
     * @returns
     */
    public getSchema(profileType: string): Record<string, unknown> {
        const profileManager = this.getCliProfileManager(profileType);
        const configOptions = Array.from(profileManager.configurations);
        let schema = {};
        for (const val of configOptions) {
            if (val.type === profileType) {
                schema = val.schema.properties;
            }
        }
        return schema;
    }

    /**
     * get array of profile types
     * @returns string[]
     */
    public getAllTypes(): string[] {
        return this.allTypes;
    }

    /**
     * get array of Profile names by type
     * @param type  profile type
     * @returns string[]
     */
    public async getNamesForType(type: string): Promise<string[]> {
        const profilesForType = await this.fetchAllProfilesByType(type);
        return profilesForType.map((profile) => {
            return profile.name;
        });
    }

    /**
     * get array of IProfileLoaded by type
     * @param type profile type
     * @returns IProfileLoaded[]
     */
    public async fetchAllProfilesByType(type: string): Promise<zowe.imperative.IProfileLoaded[]> {
        const profByType: zowe.imperative.IProfileLoaded[] = [];
        const mProfileInfo = await this.getProfileInfo();
        const profilesForType = mProfileInfo.getAllProfiles(type);
        if (profilesForType && profilesForType.length > 0) {
            for (const prof of profilesForType) {
                const profAttr = this.getMergedAttrs(mProfileInfo, prof);
                let profile = this.getProfileLoaded(prof.profName, prof.profType, profAttr);
                profile = this.checkMergingConfigSingleProfile(profile);
                profByType.push(profile);
            }
        }
        return profByType;
    }

    /**
     * Direct load and return of particular IProfileLoaded
     * @param type profile type
     * @param name profile name
     * @returns IProfileLoaded
     */
    public async directLoad(type: string, name: string): Promise<zowe.imperative.IProfileLoaded> {
        const profsOfType = await this.fetchAllProfilesByType(type);
        if (profsOfType && profsOfType.length > 0) {
            for (const profile of profsOfType) {
                if (profile.name === name) {
                    return profile;
                }
            }
        }
        return;
    }

    public async getProfileFromConfig(profileName: string): Promise<zowe.imperative.IProfAttrs> {
        const mProfileInfo = await this.getProfileInfo();
        const configAllProfiles = mProfileInfo.getAllProfiles().filter((temp) => temp.profLoc.osLoc.length !== 0);
        const currentProfile = configAllProfiles.filter((temprofile) => temprofile.profName === profileName)[0];
        return currentProfile;
    }

    public async getLoadedProfConfig(profileName: string): Promise<zowe.imperative.IProfileLoaded> {
        const mProfileInfo = await this.getProfileInfo();
        const currentProfile = await this.getProfileFromConfig(profileName);
        if (currentProfile == null) return undefined;
        const profile = this.getMergedAttrs(mProfileInfo, currentProfile);
        return this.getProfileLoaded(currentProfile.profName, currentProfile.profType, profile);
    }

    /**
     * V1 specific used by Zowe Explorer to handle v1 profiles
     * @param type string, profile type
     * @returns zowe.imperative.CliProfileManager
     */
    public getCliProfileManager(type: string): zowe.imperative.CliProfileManager {
        let profileManager = this.profileManagerByType.get(type);
        if (!profileManager) {
            try {
                profileManager = new zowe.imperative.CliProfileManager({
                    profileRootDirectory: path.join(getZoweDir(), "profiles"),
                    type,
                });
            } catch (error) {
                this.log.debug(error);
            }
            if (profileManager) {
                this.profileManagerByType.set(type, profileManager);
            } else {
                return undefined;
            }
        }
        return profileManager;
    }

    // This will retrieve the saved base profile in the allProfiles array
    public getBaseProfile(): zowe.imperative.IProfileLoaded {
        let baseProfile: zowe.imperative.IProfileLoaded;
        for (const baseP of this.allProfiles) {
            if (baseP.type === "base") {
                baseProfile = baseP;
            }
        }
        return baseProfile;
    }

    // This will retrieve the base profile from imperative
    public async fetchBaseProfile(): Promise<zowe.imperative.IProfileLoaded> {
        const mProfileInfo = await this.getProfileInfo();
        const baseProfileAttrs = mProfileInfo.getDefaultProfile("base");
        const profAttr = this.getMergedAttrs(mProfileInfo, baseProfileAttrs);
        return this.getProfileLoaded(baseProfileAttrs.profName, baseProfileAttrs.profType, profAttr);
    }

    /**
     * This returns true or false depending on if credentials are stored securely.
     *
     * @returns {boolean}
     */
    public async isCredentialsSecured(): Promise<boolean> {
        try {
            return (await this.getProfileInfo()).isSecured();
        } catch (error) {
            this.log.error(error);
        }
    }

    /**
     * This returns true or false depending on if SCS plugin is installed. Use isCredentialsSecured().
     * @deprecated
     * @returns {boolean}
     */
    public isSecureCredentialPluginActive(): boolean {
        let imperativeIsSecure = false;
        try {
            const fileName = path.join(getZoweDir(), "settings", "zowe.imperative.json");
            let settings: Record<string, unknown>;
            if (fs.existsSync(fileName)) {
                settings = JSON.parse(fs.readFileSync(fileName, "utf-8")) as Record<string, unknown>;
            }
            if (settings) {
                const baseValue = settings.overrides as Record<string, unknown>;
                const value1 = baseValue.CredentialManager;
                const value2 = baseValue["credential-manager"];
                imperativeIsSecure =
                    (typeof value1 === "string" && value1.length > 0) ||
                    (typeof value2 === "string" && value2.length > 0);
            }
        } catch (error) {
            this.log.error(error);
        }
        return imperativeIsSecure;
    }

    public getProfileLoaded(
        profileName: string,
        profileType: string,
        profile: zowe.imperative.IProfile
    ): zowe.imperative.IProfileLoaded {
        return {
            message: "",
            name: profileName,
            type: profileType,
            profile,
            failNotFound: false,
        };
    }

    // used by Zowe Explorer for v1 profiles
    protected async deleteProfileOnDisk(ProfileInfo: zowe.imperative.IProfileLoaded): Promise<void> {
        await this.getCliProfileManager(ProfileInfo.type).delete({
            profile: ProfileInfo,
            name: ProfileInfo.name,
            type: ProfileInfo.type,
        });
    }

    // used by Zowe Explorer for v1 profiles
    protected async saveProfile(
        profileInfo: Record<string, unknown>,
        profileName: string,
        profileType: string
    ): Promise<zowe.imperative.IProfile> {
        const newProfile = await this.getCliProfileManager(profileType).save({
            profile: profileInfo,
            name: profileName,
            type: profileType,
            overwrite: true,
        });
        return newProfile.profile;
    }

    // used by refresh to check correct merging of allProfiles
    protected checkMergingConfigAllProfiles(): void {
        const baseProfile = this.defaultProfileByType.get("base");
        const allProfiles: zowe.imperative.IProfileLoaded[] = [];
        this.allTypes.forEach((type) => {
            try {
                const allProfilesByType: zowe.imperative.IProfileLoaded[] = [];
                const profByType = this.profilesByType.get(type);
                profByType.forEach((profile) => {
                    if (
                        baseProfile?.profile?.host &&
                        baseProfile?.profile?.port &&
                        profile?.profile?.host &&
                        profile?.profile?.port &&
                        (baseProfile?.profile.host !== profile?.profile.host ||
                            baseProfile?.profile.port !== profile?.profile.port) &&
                        profile?.profile.tokenType == "apimlAuthenticationToken"
                    ) {
                        profile.profile.tokenType = undefined;
                        profile.profile.tokenValue = undefined;
                        // update default profile of type if changed
                        if (profile.name === this.defaultProfileByType.get(type).name) {
                            this.defaultProfileByType.set(type, profile);
                        }
                    }
                    allProfiles.push(profile);
                    allProfilesByType.push(profile);
                });
                this.profilesByType.set(type, allProfilesByType);
            } catch (error) {
                // do nothing, skip if profile type is not included in config file
            }
        });
        this.allProfiles = [];
        this.allProfiles.push(...allProfiles);
    }

    // check correct merging of a single profile
    protected checkMergingConfigSingleProfile(profile: zowe.imperative.IProfileLoaded): zowe.imperative.IProfileLoaded {
        const baseProfile = this.defaultProfileByType.get("base");
        if (
            (baseProfile?.profile.host !== profile?.profile.host ||
                baseProfile?.profile?.port !== profile?.profile.port) &&
            profile?.profile.tokenType == "apimlAuthenticationToken"
        ) {
            profile.profile.tokenType = undefined;
            profile.profile.tokenValue = undefined;
        }
        return profile;
    }

    protected getMergedAttrs(
        mProfileInfo: zowe.imperative.ProfileInfo,
        profAttrs: zowe.imperative.IProfAttrs
    ): zowe.imperative.IProfile {
        const profile: zowe.imperative.IProfile = {};
        if (profAttrs != null) {
            const mergedArgs = mProfileInfo.mergeArgsForProfile(profAttrs, { getSecureVals: true });
            for (const arg of mergedArgs.knownArgs) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                profile[arg.argName] = arg.argValue;
            }
        }
        return profile;
    }

    // create an array that includes registered types from apiRegister.registeredApiTypes()
    // and allExternalTypes
    private getAllProfileTypes(registeredTypes: string[]): string[] {
        const externalTypeArray: string[] = Array.from(this.allExternalTypes);
        const allTypes = registeredTypes.concat(
            externalTypeArray.filter((exType) => registeredTypes.every((type) => type !== exType))
        );
        return allTypes;
    }
}
