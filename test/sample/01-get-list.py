import boto3
import os

BUCKET_NAME = 'nginx-images'

def get_client():
    key_id = os.environ.get('AWS_ACCESS_KEY_ID')
    secret = os.environ.get('AWS_SECRET_ACCESS_KEY')
    stoken = os.environ.get('AWS_SESSION_TOKEN')
    s3 = boto3.client('s3',
                      region_name='us-east-2',
                      aws_access_key_id=key_id,
                      aws_secret_access_key=secret,
                      aws_session_token=stoken)
    return s3


def list_files_01():
    s3 = get_client()
    for key in s3.list_objects(Bucket=BUCKET_NAME)['Contents']:
        print(key['Key'])


def list_files_02():
    s3 = boto3.resource('s3')
    bucket = s3.Bucket(BUCKET_NAME)
    for file in bucket.objects.all():
        print(file.key)

# list_files_01()
list_files_02()
