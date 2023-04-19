#!/usr/bin/env bash
#
#  Copyright 2020 F5 Networks
#
#  Licensed under the Apache License, Version 2.0 (the "License");
#  you may not use this file except in compliance with the License.
#  You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
#  Unless required by applicable law or agreed to in writing, software
#  distributed under the License is distributed on an "AS IS" BASIS,
#  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#  See the License for the specific language governing permissions and
#  limitations under the License.
#

# This script checks to see that required environment variables were correctly
# passed into the Docker container.

set -e

failed=0

required=("S3_BUCKET_NAME" "S3_SERVER" "S3_SERVER_PORT" "S3_SERVER_PROTO"
"S3_REGION" "S3_STYLE" "ALLOW_DIRECTORY_LIST" "AWS_SIGS_VERSION"
"CORS_ENABLED")

# Require some form of authentication to be configured.

# a) Using container credentials. This is indicated by AWS_CONTAINER_CREDENTIALS_RELATIVE_URI being set.
#    See https://docs.aws.amazon.com/sdkref/latest/guide/feature-container-credentials.html
#    Example: We are running inside an ECS task.
if [[ -v AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ]]; then
  echo "Running inside an ECS task, using container credentials"

elif [[ -v AWS_SESSION_TOKEN ]]; then
  echo "S3 Session token specified - not using IMDS for credentials"

# b) Using Instance Metadata Service (IMDS) credentials, if IMDS is present at http://169.254.169.254.
#    See https://docs.aws.amazon.com/sdkref/latest/guide/feature-imds-credentials.html.
#    Example: We are running inside an EC2 instance.
elif curl --output /dev/null --silent --head --fail --connect-timeout 2 --max-time 5 "http://169.254.169.254"; then
  echo "Running inside an EC2 instance, using IMDS for credentials"

# c) Using assume role credentials. This is indicated by AWS_WEB_IDENTITY_TOKEN_FILE being set.
#    See https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-role.html.
#    Example: We are running inside an EKS cluster with IAM roles for service accounts enabled.
elif [[ -v AWS_WEB_IDENTITY_TOKEN_FILE ]]; then
  echo "Running inside EKS with IAM roles for service accounts"

# If none of the options above is used, require static credentials.
# See https://docs.aws.amazon.com/sdkref/latest/guide/feature-static-credentials.html.
else
  required+=("AWS_ACCESS_KEY_ID" "AWS_SECRET_ACCESS_KEY")
fi

for name in ${required[@]}; do
  if [[ ! -v name ]]; then
      >&2 echo "Required ${name} environment variable missing"
      failed=1
  fi
done

if [ "${S3_SERVER_PROTO}" != "http" ] && [ "${S3_SERVER_PROTO}" != "https" ]; then
    >&2 echo "S3_SERVER_PROTO contains an invalid value (${S3_SERVER_PROTO}). Valid values: http, https"
    failed=1
fi

if [ "${AWS_SIGS_VERSION}" != "2" ] && [ "${AWS_SIGS_VERSION}" != "4" ]; then
  >&2 echo "AWS_SIGS_VERSION contains an invalid value (${AWS_SIGS_VERSION}). Valid values: 2, 4"
  failed=1
fi

parseBoolean() {
  case "$1" in
    TRUE | true | True | YES | Yes | 1)
      echo 1
      ;;
    *)
      echo 0
      ;;
  esac
}

if [ "$(parseBoolean ${ALLOW_DIRECTORY_LIST})" == "1" ] && [ "$(parseBoolean ${PROVIDE_INDEX_PAGE})" == "1" ]; then
  >&2 echo "ALLOW_DIRECTORY_LIST and PROVIDE_INDEX_PAGE cannot be both set"
  failed=1
fi

if [ -n "${HEADER_PREFIXES_TO_STRIP+x}" ]; then
  if [[ "${HEADER_PREFIXES_TO_STRIP}" =~ [A-Z] ]]; then
    >&2 echo "HEADER_PREFIXES_TO_STRIP must not contain uppercase characters"
    failed=1
  fi
fi


if [ $failed -gt 0 ]; then
  exit 1
fi

echo "S3 Backend Environment"
echo "Access Key ID: ${AWS_ACCESS_KEY_ID}"
echo "Origin: ${S3_SERVER_PROTO}://${S3_BUCKET_NAME}.${S3_SERVER}:${S3_SERVER_PORT}"
echo "Region: ${S3_REGION}"
echo "Addressing Style: ${S3_STYLE}"
echo "AWS Signatures Version: v${AWS_SIGS_VERSION}"
echo "DNS Resolvers: ${DNS_RESOLVERS}"
echo "Directory Listing Enabled: ${ALLOW_DIRECTORY_LIST}"
echo "Provide Index Pages Enabled: ${PROVIDE_INDEX_PAGE}"
echo "Append slash for directory enabled: ${APPEND_SLASH_FOR_POSSIBLE_DIRECTORY}"
echo "Stripping the following headers from responses: x-amz-;${HEADER_PREFIXES_TO_STRIP}"
echo "CORS Enabled: ${CORS_ENABLED}"
