using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew;
using StardewModdingAPI;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class HostFarmhandProvisionerPublicationTests
{
    [Fact]
    public void WriteJson_ReturnsFalseWhenAtomicMoveCannotReplaceDirectory()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"gamebuddy-provisioning-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        string targetDirectory = Path.Combine(directory, FarmhandProvisioningProtocol.ManifestFileName);
        Directory.CreateDirectory(targetDirectory);
        try
        {
            object provisioner = RuntimeHelpers.GetUninitializedObject(typeof(HostFarmhandProvisioner));
            SetField(provisioner, "sessionDirectory", directory);
            SetField(provisioner, "monitor", new DummyMonitor());

            bool published = InvokePrivate<bool>(provisioner, "WriteJson", FarmhandProvisioningProtocol.ManifestFileName, new FarmhandJoinManifest
            {
                SchemaVersion = FarmhandProvisioningProtocol.Version,
            });

            published.Should().BeFalse();
            Directory.Exists(targetDirectory).Should().BeTrue();

            InvokePrivate<object>(provisioner, "EnterQuarantine", "manifest_publication_failed");
            IsQuarantined(provisioner).Should().BeTrue();
            InvokePrivate<object>(provisioner, "PublishFixtureReadiness", "fixture", "save", "fixture_ready", "ready");
            File.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.FixtureReadinessFileName)).Should().BeFalse();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ManifestPublicationFailure_IsUncertainAndQuarantinesFurtherPublication()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"gamebuddy-provisioning-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            object provisioner = CreateUninitializedProvisioner(directory);

            FarmhandProvisioningResult result = InvokePrivate<FarmhandProvisioningResult>(provisioner, "ManifestPublicationFailed", 42L);

            result.State.Should().Be("uncertain");
            result.ReasonCode.Should().Be("manifest_publication_failed");
            result.FarmhandId.Should().Be(42L);
            IsQuarantined(provisioner).Should().BeTrue();
            InvokePrivate<object>(provisioner, "PublishFixtureReadiness", "fixture", "save", "fixture_ready", "ready");
            File.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.FixtureReadinessFileName)).Should().BeFalse();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ReadyManifestCleanupFailure_QuarantinesAndSuppressesFurtherPublication()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"gamebuddy-provisioning-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        Directory.CreateDirectory(Path.Combine(directory, FarmhandProvisioningProtocol.ManifestFileName));
        try
        {
            object provisioner = CreateUninitializedProvisioner(directory);

            InvokePrivate<bool>(provisioner, "RemoveAdvertisementAndManifestOrQuarantine").Should().BeFalse();

            IsQuarantined(provisioner).Should().BeTrue();
            InvokePrivate<object>(provisioner, "PublishFixtureReadiness", "fixture", "save", "fixture_ready", "ready");
            File.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.AdvertisementFileName)).Should().BeFalse();
            Directory.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.ManifestFileName)).Should().BeTrue();
            File.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.FixtureReadinessFileName)).Should().BeFalse();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData("stardew-attachment-request.json")]
    [InlineData("stardew-attachment-response.json")]
    [InlineData("stardew-fixture-readiness.json")]
    public void Constructor_WhenRequiredStaleArtifactCannotBeRemoved_StartsQuarantined(string staleArtifact)
    {
        string directory = Path.Combine(Path.GetTempPath(), $"gamebuddy-provisioning-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        Directory.CreateDirectory(Path.Combine(directory, staleArtifact));
        try
        {
            object provisioner = CreateProvisioner(directory);

            IsQuarantined(provisioner).Should().BeTrue();
            InvokePrivate<object>(provisioner, "ProcessRequest", 0L);
            InvokePrivate<object>(provisioner, "PublishFixtureReadiness", "fixture", "save", "fixture_ready", "ready");

            File.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.RequestFileName)).Should().BeFalse();
            File.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.AdvertisementFileName)).Should().BeFalse();
            File.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.ManifestFileName)).Should().BeFalse();
            File.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.FixtureReadinessFileName)).Should().BeFalse();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void WriteResponse_WhenAtomicMoveCannotReplaceDirectory_QuarantinesWithoutPublishingFallback()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"gamebuddy-provisioning-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        Directory.CreateDirectory(Path.Combine(directory, FarmhandProvisioningProtocol.ResponseFileName));
        try
        {
            object provisioner = CreateUninitializedProvisioner(directory);

            bool published = InvokePrivate<bool>(provisioner, "WriteResponse", new FarmhandAttachmentResponse
            {
                SchemaVersion = FarmhandProvisioningProtocol.Version,
                RequestId = "request_01",
                State = "ready",
                ReasonCode = "manifest_issued",
            });

            published.Should().BeFalse();
            IsQuarantined(provisioner).Should().BeTrue();
            ((FarmhandAttachmentResponse)GetField(provisioner, "lastResponse")!).State.Should().Be("rejected");
            ((FarmhandAttachmentResponse)GetField(provisioner, "lastResponse")!).ReasonCode.Should().Be("response_publication_failed");
            InvokePrivate<object>(provisioner, "PublishFixtureReadiness", "fixture", "save", "fixture_ready", "ready");
            File.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.FixtureReadinessFileName)).Should().BeFalse();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void PersistPendingBinding_WhenWriteSaveDataFails_QuarantinesAllLaterLifecycleActivity()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"gamebuddy-provisioning-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var data = DispatchProxy.Create<IDataHelper, ThrowingSaveDataProxy>();
            var dataProxy = (ThrowingSaveDataProxy)(object)data;
            var helper = DispatchProxy.Create<IModHelper, ModHelperProxy>();
            ((ModHelperProxy)(object)helper).Data = data;
            object provisioner = CreateUninitializedProvisioner(directory);
            SetField(provisioner, "helper", helper);
            SetField(provisioner, "pendingSaveRequest", new FarmhandAttachmentRequest { RequestId = "request_01" });
            SetField(provisioner, "pendingSaveObserved", true);

            InvokePrivate<object>(provisioner, "PersistPendingBinding");

            dataProxy.WriteAttempts.Should().Be(1);
            IsQuarantined(provisioner).Should().BeTrue();
            ((FarmhandAttachmentResponse)GetField(provisioner, "lastResponse")!).ReasonCode.Should().Be("save_persistence_failed");

            File.WriteAllText(Path.Combine(directory, FarmhandProvisioningProtocol.RequestFileName), "{}");
            InvokePrivate<object>(provisioner, "OnSaved");
            InvokePrivate<object>(provisioner, "Update");
            InvokePrivate<object>(provisioner, "ProcessRequest", 0L);
            InvokePrivate<bool>(provisioner, "PublishFixtureReadiness", "fixture", "save", "fixture_ready", "ready").Should().BeFalse();

            File.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.RequestFileName)).Should().BeTrue();
            File.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.ResponseFileName)).Should().BeFalse();
            File.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.ManifestFileName)).Should().BeFalse();
            File.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.FixtureReadinessFileName)).Should().BeFalse();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void PublishFixtureReadiness_WhenAtomicMoveCannotReplaceDirectory_ReturnsFalseAndCallerProjectionRemainsFalse()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"gamebuddy-provisioning-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        Directory.CreateDirectory(Path.Combine(directory, FarmhandProvisioningProtocol.FixtureReadinessFileName));
        try
        {
            object provisioner = CreateUninitializedProvisioner(directory);
            object modEntry = CreateUninitializedModEntry(provisioner);

            InvokeModEntryPublishFixtureReadiness(modEntry);

            IsQuarantined(provisioner).Should().BeTrue();
            ((FarmhandAttachmentResponse)GetField(provisioner, "lastResponse")!).ReasonCode.Should().Be("fixture_readiness_publication_failed");
            GetModEntryField<bool>(modEntry, "hostAutomationFixtureReadinessPublished").Should().BeFalse();
            InvokePrivate<bool>(provisioner, "WriteResponse", new FarmhandAttachmentResponse()).Should().BeFalse();
            File.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.ResponseFileName)).Should().BeFalse();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void PublishFixtureReadiness_WhenAlreadyQuarantined_ReturnsFalseAndCallerProjectionRemainsFalse()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"gamebuddy-provisioning-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            object provisioner = CreateUninitializedProvisioner(directory);
            object modEntry = CreateUninitializedModEntry(provisioner);
            InvokePrivate<object>(provisioner, "EnterQuarantine", "publication_cleanup_failed");

            InvokePrivate<bool>(provisioner, "PublishFixtureReadiness", "fixture", "save", "fixture_ready", "ready").Should().BeFalse();
            InvokeModEntryPublishFixtureReadiness(modEntry);

            GetModEntryField<bool>(modEntry, "hostAutomationFixtureReadinessPublished").Should().BeFalse();
            File.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.FixtureReadinessFileName)).Should().BeFalse();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void SuccessfulResponseAndFixturePublications_AreSignedAndDoNotQuarantine()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"gamebuddy-provisioning-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            object provisioner = CreateUninitializedProvisioner(directory);
            var response = new FarmhandAttachmentResponse
            {
                SchemaVersion = FarmhandProvisioningProtocol.Version,
                RequestId = "request_01",
                State = "ready",
                ReasonCode = "manifest_issued",
                ManifestPath = FarmhandProvisioningProtocol.ManifestFileName,
            };

            InvokePrivate<bool>(provisioner, "WriteResponse", response).Should().BeTrue();
            InvokePrivate<bool>(provisioner, "PublishFixtureReadiness", "fixture", "save", "fixture_ready", "ready").Should().BeTrue();
            object modEntry = CreateUninitializedModEntry(provisioner);
            InvokeModEntryPublishFixtureReadiness(modEntry);
            GetModEntryField<bool>(modEntry, "hostAutomationFixtureReadinessPublished").Should().BeTrue();

            FarmhandAttachmentResponse writtenResponse = JsonSerializer.Deserialize<FarmhandAttachmentResponse>(File.ReadAllText(Path.Combine(directory, FarmhandProvisioningProtocol.ResponseFileName)), FarmhandProvisioningProtocol.JsonOptions)!;
            FixtureReadinessReport writtenReadiness = JsonSerializer.Deserialize<FixtureReadinessReport>(File.ReadAllText(Path.Combine(directory, FarmhandProvisioningProtocol.FixtureReadinessFileName)), FarmhandProvisioningProtocol.JsonOptions)!;
            FarmhandProvisioningProtocol.HasValidSignature(writtenResponse, writtenResponse.Signature, new string('a', 16)).Should().BeTrue();
            FarmhandProvisioningProtocol.HasValidSignature(writtenReadiness, writtenReadiness.Signature, new string('a', 16)).Should().BeTrue();
            IsQuarantined(provisioner).Should().BeFalse();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void EnterQuarantine_PreventsFurtherReadinessPublication()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"gamebuddy-provisioning-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            object provisioner = RuntimeHelpers.GetUninitializedObject(typeof(HostFarmhandProvisioner));
            SetField(provisioner, "sessionDirectory", directory);
            SetField(provisioner, "monitor", new DummyMonitor());
            SetField(provisioner, "config", new HostFarmhandProvisioningConfig
            {
                SessionToken = new string('a', 16),
            });

            InvokePrivate<object>(provisioner, "EnterQuarantine", "publication_cleanup_failed");
            IsQuarantined(provisioner).Should().BeTrue();

            InvokePrivate<object>(provisioner, "PublishFixtureReadiness", "fixture", "save", "fixture_ready", "ready");
            File.Exists(Path.Combine(directory, FarmhandProvisioningProtocol.FixtureReadinessFileName)).Should().BeFalse();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void DeleteIfOwned_ReturnsFalseWhenArtifactCannotBeDeleted()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"gamebuddy-provisioning-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        string targetDirectory = Path.Combine(directory, FarmhandProvisioningProtocol.AdvertisementFileName);
        Directory.CreateDirectory(targetDirectory);
        try
        {
            object provisioner = RuntimeHelpers.GetUninitializedObject(typeof(HostFarmhandProvisioner));
            SetField(provisioner, "sessionDirectory", directory);
            SetField(provisioner, "monitor", new DummyMonitor());

            bool deleted = InvokePrivate<bool>(provisioner, "DeleteIfOwned", FarmhandProvisioningProtocol.AdvertisementFileName);

            deleted.Should().BeFalse();
            Directory.Exists(targetDirectory).Should().BeTrue();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static object CreateProvisioner(string directory)
    {
        ConstructorInfo constructor = typeof(HostFarmhandProvisioner).GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic).Single();
        return constructor.Invoke(new object?[]
        {
            null,
            new DummyMonitor(),
            new HostFarmhandProvisioningConfig { SessionToken = new string('a', 16) },
            directory,
            false,
        });
    }

    private static object CreateUninitializedProvisioner(string directory)
    {
        object provisioner = RuntimeHelpers.GetUninitializedObject(typeof(HostFarmhandProvisioner));
        SetField(provisioner, "sessionDirectory", directory);
        SetField(provisioner, "monitor", new DummyMonitor());
        SetField(provisioner, "config", new HostFarmhandProvisioningConfig { SessionToken = new string('a', 16) });
        SetField(provisioner, "sessionNonce", "session_01");
        return provisioner;
    }

    private static object CreateUninitializedModEntry(object provisioner)
    {
        object modEntry = RuntimeHelpers.GetUninitializedObject(typeof(ModEntry));
        typeof(ModEntry).GetField("hostFarmhandProvisioner", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(modEntry, provisioner);
        return modEntry;
    }

    private static void InvokeModEntryPublishFixtureReadiness(object modEntry)
    {
        typeof(ModEntry).GetMethod("PublishFixtureReadiness", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(modEntry, new object[]
        {
            new HostAutomationConfig { FixtureScenario = "fixture", SaveName = "save" },
            "fixture_ready",
            "ready",
        });
    }

    private static T GetModEntryField<T>(object modEntry, string name) =>
        (T)typeof(ModEntry).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(modEntry)!;

    private static bool IsQuarantined(object provisioner) => (bool)GetField(provisioner, "quarantined")!;

    private static object? GetField(object instance, string name) =>
        typeof(HostFarmhandProvisioner).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(instance);

    private static void SetField(object instance, string name, object value) =>
        typeof(HostFarmhandProvisioner).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(instance, value);

    private static T InvokePrivate<T>(object instance, string name, params object[] arguments)
    {
        MethodInfo method = typeof(HostFarmhandProvisioner).GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic)!;
        if (method.IsGenericMethodDefinition)
            method = method.MakeGenericMethod(arguments[^1].GetType());
        object? result = method.Invoke(instance, arguments);
        return result is null ? default! : (T)result;
    }

    private class ModHelperProxy : DispatchProxy
    {
        internal IDataHelper Data { get; set; } = null!;

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod?.Name == "get_Data")
                return this.Data;
            throw new NotSupportedException(targetMethod?.Name);
        }
    }

    private class ThrowingSaveDataProxy : DispatchProxy
    {
        internal int WriteAttempts { get; private set; }

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod?.Name == "ReadSaveData")
                return new FarmhandBindingStore();
            if (targetMethod?.Name == "WriteSaveData")
            {
                this.WriteAttempts++;
                throw new IOException("simulated_write_failure");
            }
            throw new NotSupportedException(targetMethod?.Name);
        }
    }
}
